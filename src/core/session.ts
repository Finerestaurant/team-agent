import { AsyncLocalStorage } from "node:async_hooks"
import type { TeamNode } from "../types.ts"
import { emit } from "../ui/event-bus.ts"
import * as logger from "./logger.ts"

export type SessionStatus = "active" | "waiting" | "paused" | "done" | "error" | "cancelled"

// Minimal interface shared by the real/mock sessions runTask() creates.
// Session itself doesn't need to know this type — it only takes closures already
// bound at construction time (promptFn/abortFn/getResult/getMessages).
export type AgentSessionLike = {
  prompt(msg: string): Promise<void>
  readonly messages: any[]
  subscribe(cb: (event: any) => void): () => void
  abort(): void
  dispose(): void
}

export const trackerStore = new AsyncLocalStorage<Session>()

type SessionInit = {
  taskId: string
  nodeId: string
  agentName: string
  depth: number
  parent?: Session
  promptFn: (msg: string) => Promise<void>
  abortFn: () => void
  getResult: () => string
  getMessages: () => any[]
}

export class Session {
  readonly taskId: string
  readonly nodeId: string
  readonly agentName: string
  readonly depth: number
  readonly parent?: Session
  status: SessionStatus = "active"
  pendingCount = 0
  result?: string
  lastTool?: string
  toolsCalled: string[] = []
  readonly startedAt = Date.now()
  pendingNotifications: string[] = []

  private readonly promptFn: (msg: string) => Promise<void>
  private readonly abortFn: () => void
  private readonly getResultFn: () => string
  readonly getMessages: () => any[]
  private pausedFrom?: SessionStatus
  private finished = false
  private onCleanup?: () => void

  constructor(init: SessionInit) {
    this.taskId = init.taskId
    this.nodeId = init.nodeId
    this.agentName = init.agentName
    this.depth = init.depth
    this.parent = init.parent
    this.promptFn = init.promptFn
    this.abortFn = init.abortFn
    this.getResultFn = init.getResult
    this.getMessages = init.getMessages
  }

  // runTask() registers the cleanup closure here (unsubscribe/remove abort listener/etc.)
  setCleanup(fn: () => void): void {
    this.onCleanup = fn
  }

  private cleanup(): void {
    this.onCleanup?.()
  }

  markWaiting(): void {
    if (this.finished) return
    this.status = "waiting"
    emit({ type: "agent:waiting", nodeId: this.nodeId, agentName: this.agentName })
  }

  // pendingCount===0 means done, otherwise WAITING. Called at every completion checkpoint
  // (own prompt finishing, or after a child's result has been applied).
  checkDone(): void {
    if (this.finished) return
    if (this.pendingCount === 0) this.markDone(this.getResultFn())
    else this.markWaiting()
  }

  markDone(result: string): void {
    if (this.finished) return
    this.finished = true
    this.status = "done"
    this.result = result
    emit({ type: "agent:end", nodeId: this.nodeId, agentName: this.agentName, status: "done", isBackground: true, taskId: this.taskId, result })
    logger.log(this.depth, this.agentName, "DONE", { taskId: this.taskId, result: result.slice(0, 200) })
    this.cleanup()
    this.reportToParent(`[task_complete] ${this.agentName} done:\n${result}`)
  }

  markError(message: string): void {
    if (this.finished) return
    this.finished = true
    this.status = "error"
    this.result = message
    emit({ type: "agent:end", nodeId: this.nodeId, agentName: this.agentName, status: "error", isBackground: true, taskId: this.taskId, result: message })
    logger.log(this.depth, this.agentName, "ERROR", { taskId: this.taskId, error: message })
    this.cleanup()
    this.reportToParent(`[task_error] ${this.agentName} error:\n${message}`)
  }

  private reportToParent(msg: string): void {
    const parent = this.parent
    if (!parent) return
    if (parent.status === "paused") {
      parent.pendingNotifications.push(msg)
      return
    }
    parent.pendingCount--
    emit({ type: "agent:resumed", nodeId: parent.nodeId, agentName: parent.agentName })
    trackerStore.run(parent, () => parent.promptFn(msg))
      .then(() => parent.checkDone())
      .catch((e) => {
        logger.log(this.depth, this.agentName, "PARENT-RESUME-ERROR", { error: e instanceof Error ? e.message : String(e) })
      })
  }

  // ── pause/resume/cancel: only change this session's own state. Cascading is SessionRegistry's job ──

  pause(): void {
    if (this.status !== "active" && this.status !== "waiting") return
    this.pausedFrom = this.status
    this.status = "paused"
    emit({ type: "agent:paused", nodeId: this.nodeId, agentName: this.agentName })
  }

  async resume(instruction?: string): Promise<void> {
    if (this.status !== "paused") return
    this.status = this.pausedFrom ?? "active"
    this.pausedFrom = undefined
    emit({ type: "agent:unpaused", nodeId: this.nodeId, agentName: this.agentName })

    const queued = this.pendingNotifications.splice(0)
    for (const msg of queued) {
      this.pendingCount--
      await trackerStore.run(this, () => this.promptFn(msg))
    }
    // It's tempting to just stop here when there's no instruction and the queue is empty, but
    // then this session's real agent never gets a single turn — its status just flips and it
    // falls straight into checkDone(). That means it never gets a chance to reason about
    // "one of my own direct children might still be paused, should I relay resume_child?" —
    // making model (b)'s relay structurally impossible. Always give at least a minimal wake-up
    // turn, even without an instruction.
    const wakeup = instruction
      ?? (queued.length === 0
        ? "[resumed] You were resumed with no new instruction. If any of your own direct children are still paused, call resume_child on them to relay this resume further down the tree. Otherwise, just continue."
        : undefined)
    if (wakeup) {
      await trackerStore.run(this, () => this.promptFn(wakeup))
    }
    this.checkDone()
  }

  cancel(): void {
    if (this.finished || this.status === "cancelled") return
    this.finished = true
    this.status = "cancelled"
    this.abortFn()
    emit({ type: "agent:end", nodeId: this.nodeId, agentName: this.agentName, status: "cancelled", isBackground: true, taskId: this.taskId })
    logger.log(this.depth, this.agentName, "CANCELLED", { taskId: this.taskId })
    this.cleanup()
  }
}

export class SessionRegistry {
  readonly team: TeamNode
  private readonly sessions = new Map<string, Session>()

  constructor(team: TeamNode) {
    this.team = team
    // Dump once right after construction so it's immediately verifiable from the logs that
    // this reuses the cartridge's TeamNode as-is rather than building a separate tree — at
    // this point no Session has attached yet, so everything should correctly show [idle].
    this.logTree(`registry created (root=${team.name})`)
  }

  private dumpNode(node: TeamNode, prefix: string): string[] {
    const s = this.byName(node.name)
    const label = s
      ? `${node.name} [${s.status}] taskId=${s.taskId} pending=${s.pendingCount}`
      : `${node.name} [idle]`
    const lines = [`${prefix}${label}`]
    for (const child of node.children) lines.push(...this.dumpNode(child, `${prefix}  `))
    return lines
  }

  // Full tree snapshot at this exact moment — walks the fixed TeamNode structure, reading
  // each position's live Session.status.
  dumpTree(): string[] {
    return this.dumpNode(this.team, "")
  }

  private logTree(trigger: string): void {
    logger.logTree(trigger, this.dumpTree())
  }

  byName(name: string): Session | undefined {
    return this.sessions.get(name)
  }

  byTaskId(taskId: string): Session | undefined {
    for (const s of this.sessions.values()) if (s.taskId === taskId) return s
    return undefined
  }

  root(): Session | undefined {
    return this.byName(this.team.name)
  }

  attach(session: Session): void {
    this.sessions.set(session.agentName, session)
    this.logTree(`attach ${session.agentName} (taskId=${session.taskId})`)
  }

  private findNode(name: string, node: TeamNode = this.team): TeamNode | undefined {
    if (node.name === name) return node
    for (const child of node.children) {
      const found = this.findNode(name, child)
      if (found) return found
    }
    return undefined
  }

  // callerName === undefined means PI (interactive) itself is the caller → the only legal target is root
  childrenOf(callerName: string | undefined): string[] {
    if (callerName === undefined) return [this.team.name]
    return this.findNode(callerName)?.children.map((c) => c.name) ?? []
  }

  // ctrl+/ only — the sole action allowed to cascade the entire tree, since it's a
  // side-effect-free instant freeze
  pauseSubtree(node: TeamNode = this.team): void {
    this.pauseSubtreeInternal(node)
    this.logTree(`pauseSubtree(${node.name})`)
  }

  private pauseSubtreeInternal(node: TeamNode): void {
    this.byName(node.name)?.pause()
    for (const child of node.children) this.pauseSubtreeInternal(child)
  }

  // 1-hop only. No cascade — to unfreeze anything below, the just-resumed agent must call
  // this same tool itself.
  async resumeChild(callerName: string | undefined, childName: string, instruction?: string): Promise<void> {
    if (!this.childrenOf(callerName).includes(childName)) {
      this.logTree(`resumeChild(${callerName ?? "PI"} -> ${childName}) REJECTED: not a direct child`)
      throw new Error(`${childName} is not a direct child of ${callerName ?? "root"}`)
    }
    await this.byName(childName)?.resume(instruction)
    this.logTree(`resumeChild(${callerName ?? "PI"} -> ${childName}${instruction ? ", instruction" : ""})`)
  }

  // 1-hop entry, but unconditionally cascades below — the one exception CANCEL gets
  cancelChild(callerName: string | undefined, childName: string): void {
    if (!this.childrenOf(callerName).includes(childName)) {
      this.logTree(`cancelChild(${callerName ?? "PI"} -> ${childName}) REJECTED: not a direct child`)
      throw new Error(`${childName} is not a direct child of ${callerName ?? "root"}`)
    }
    const node = this.findNode(childName)
    if (node) this.cancelSubtree(node)
    this.logTree(`cancelChild(${callerName ?? "PI"} -> ${childName})`)
  }

  private cancelSubtree(node: TeamNode): void {
    for (const child of node.children) this.cancelSubtree(child)
    this.byName(node.name)?.cancel()
  }
}
