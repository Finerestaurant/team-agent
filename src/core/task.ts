import { createAgentSession, DefaultResourceLoader, defineTool } from "@earendil-works/pi-coding-agent"
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent"
import * as path from "node:path"
import * as os from "node:os"
import { Text } from "@earendil-works/pi-tui"
import { Type } from "typebox"
import { AsyncLocalStorage } from "node:async_hooks"
import type { Cartridge, AgentDef, TeamNode, ScriptStep } from "../types.ts"
import * as logger from "./logger.ts"
import { emit, on } from "../ui/event-bus.ts"
import { Session, SessionRegistry, trackerStore } from "./session.ts"

const depthStore = new AsyncLocalStorage<number>()

let bgTaskCounter = 0

// SessionRegistry's mutation methods (attach/pauseSubtree/resumeChild/cancelChild) log a tree
// snapshot whenever they're called directly, but cases where a Session transitions on its own
// (e.g. going from WAITING back to ACTIVE after a child reports in, or reaching final
// DONE/ERROR) never go through the registry. Subscribe to the event bus once here to dump the
// tree on every transition so none of those get missed.
let treeLoggerInstalled = false
function installTreeLogger(): void {
  if (treeLoggerInstalled) return
  treeLoggerInstalled = true
  const dump = (trigger: string) => logger.logTree(trigger, getRegistry().dumpTree())
  on("agent:start", (e) => dump(`agent:start ${e.agentName} (taskId=${e.taskId})`))
  on("agent:end", (e) => dump(`agent:end ${e.agentName} (${e.status})`))
  on("agent:waiting", (e) => dump(`agent:waiting ${e.agentName}`))
  on("agent:resumed", (e) => dump(`agent:resumed ${e.agentName}`))
  on("agent:paused", (e) => dump(`agent:paused ${e.agentName}`))
  on("agent:unpaused", (e) => dump(`agent:unpaused ${e.agentName}`))
}
installTreeLogger()

// ─── Runtime state ────────────────────────────────────────────────────────────

type Runtime = {
  cartridge: Cartridge
  toolMap: Record<string, ToolDefinition<any, any>>
  createSession?: (opts: any) => Promise<{ session: any }>
}

let runtime: Runtime | undefined
let agentMap: Map<string, AgentDef>
let registry: SessionRegistry | undefined

export function setRuntime(r: Runtime): void {
  runtime = r
  agentMap = new Map(r.cartridge.agents.map((a) => [a.name, a]))
  registry = new SessionRegistry(r.cartridge.team)
}

export function getRegistry(): SessionRegistry {
  if (!registry) throw new Error("registry not initialized — call setRuntime() first")
  return registry
}

function hasDelegationChildren(tree: TeamNode, name: string): boolean {
  if (tree.name === name) return tree.children.length > 0
  return tree.children.some((c) => hasDelegationChildren(c, name))
}

// ─── Debug session ────────────────────────────────────────────────────────────

const DEBUG_DELAY_MS = 3000

function makeDebugSession(agentName: string, nodeId: string, signal: AbortSignal | undefined, ctx: ExtensionContext) {
  const childQueue = runtime?.cartridge.debugChildren?.[agentName] ?? []
  const messages: { role: string; content: { type: string; text: string }[] }[] = []
  let nextChildIndex = 0

  function say(text: string) {
    messages.push({ role: "assistant", content: [{ type: "text", text }] })
    emit({ type: "agent:activity", nodeId, text })
  }

  return {
    prompt: async (msg: string) => {
      // Synthetic wake-up signal Session.resume() sends when resumed without an instruction —
      // deterministic scripts already keep progressing on their own timers regardless of pause,
      // so just no-op here. Without this, it would fall into the "!isResume" branch below and
      // reset the already-in-progress nextChildIndex back to 0, re-spawning the first child.
      if (msg.startsWith("[resumed]")) return
      const isResume = msg.startsWith("[task_complete]") || msg.startsWith("[task_error]")
      if (!isResume) {
        await new Promise((r) => setTimeout(r, DEBUG_DELAY_MS))
        if (childQueue.length === 0) {
          say(`<task_result>[debug] ${agentName} done</task_result>`)
          return
        }
        const first = childQueue[0]!
        void runTask({ subagent_type: first, description: `debug:${first}`, prompt: msg, debug: true }, signal, ctx)
        say(`[debug] ${agentName} → ${first}`)
        nextChildIndex = 1
      } else {
        await new Promise((r) => setTimeout(r, 300))
        if (nextChildIndex < childQueue.length) {
          const next = childQueue[nextChildIndex]!
          void runTask({ subagent_type: next, description: `debug:${next}`, prompt: "debug", debug: true }, signal, ctx)
          say(`[debug] ${agentName} → ${next}`)
          nextChildIndex++
        } else {
          say(`<task_result>[debug] ${agentName} done (${childQueue.length} children)</task_result>`)
        }
      }
    },
    get messages() { return messages },
    subscribe: (_listener: any) => () => {},
    abort: () => {},
    dispose: () => {},
  }
}

// ─── Script session ───────────────────────────────────────────────────────────

function makeScriptSession(
  agentName: string,
  script: ScriptStep[],
  nodeId: string,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  depth: number,
) {
  const messages: { role: string; content: { type: string; text: string }[] }[] = []
  let listener: ((event: any) => void) | undefined
  let scriptIndex = 0
  let pendingSpawns = 0

  function say(text: string) {
    messages.push({ role: "assistant", content: [{ type: "text", text }] })
    if (!text.startsWith("<task_result>")) {
      emit({ type: "agent:activity", nodeId, text })
      logger.log(depth, agentName, "SAY", text)
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((r) => {
      const t = setTimeout(r, ms)
      signal?.addEventListener("abort", () => { clearTimeout(t); r() }, { once: true })
    })
  }

  async function runSteps(): Promise<void> {
    while (scriptIndex < script.length) {
      if (signal?.aborted) return
      const step = script[scriptIndex++]!
      switch (step.type) {
        case "delay":
          await sleep(step.ms)
          break
        case "activity":
          say(step.text)
          break
        case "tool":
          listener?.({ type: "tool_execution_start", toolName: step.name, args: {} })
          await sleep(step.ms)
          listener?.({ type: "tool_execution_end", toolName: step.name })
          break
        case "spawn":
          pendingSpawns = 1
          void runTask({ subagent_type: step.child, description: `test:${step.child}`, prompt: "run", debug: true }, signal, ctx)
          return
        case "spawn_parallel":
          pendingSpawns = step.children.length
          for (const child of step.children) {
            void runTask({ subagent_type: child, description: `test:${child}`, prompt: "run", debug: true }, signal, ctx)
          }
          return
        case "error":
          throw new Error(step.message)
      }
    }
    say(`<task_result>[test] ${agentName} done</task_result>`)
  }

  return {
    prompt: async (msg: string) => {
      // Same reason as makeDebugSession — no-op. Must not treat this the same as
      // [task_complete]/[task_error] and wrongly decrement pendingSpawns, since no child
      // actually finished.
      if (msg.startsWith("[resumed]")) return
      const isResume = msg.startsWith("[task_complete]") || msg.startsWith("[task_error]")
      if (isResume) {
        pendingSpawns--
        if (pendingSpawns > 0) return
      }
      await runSteps()
    },
    get messages() { return messages },
    subscribe: (cb: (event: any) => void) => {
      listener = cb
      return () => { listener = undefined }
    },
    abort: () => {},
    dispose: () => { listener = undefined },
  }
}

// ─── runTask ──────────────────────────────────────────────────────────────────

type TaskArgs = { subagent_type: string; description: string; prompt: string; debug?: boolean }
type TaskDetails = { agent?: string; isError?: boolean }

async function runTask(
  params: TaskArgs,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<{ content: ({ type: "text"; text: string })[]; details: TaskDetails }> {
  if (!runtime) {
    return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "task runtime not initialized" }) }], details: { isError: true } }
  }

  const agent: AgentDef | undefined = agentMap.get(params.subagent_type)
  if (!agent) {
    return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Unknown agent: ${params.subagent_type}` }) }], details: { isError: true } }
  }

  const parent = trackerStore.getStore()
  if (parent) parent.pendingCount++

  const depth = depthStore.getStore() ?? 0
  const nodeId = crypto.randomUUID()
  const taskId = `bg-${++bgTaskCounter}`

  let child: ReturnType<typeof makeDebugSession> | ReturnType<typeof makeScriptSession>

  const agentScript = runtime.cartridge.agentScripts?.[agent.name]

  if (agentScript) {
    logger.log(depth, agent.name, "SCRIPT START", { taskId })
    child = makeScriptSession(agent.name, agentScript, nodeId, signal, ctx, depth)
  } else if (params.debug) {
    logger.log(depth, agent.name, "DEBUG START", { taskId })
    child = makeDebugSession(agent.name, nodeId, signal, ctx)
  } else {
    const infraTools = hasDelegationChildren(runtime.cartridge.team, agent.name)
      ? ["await_task", "check_task", "resume_child", "cancel_child"]
      : []
    const domainToolNames = (agent.domainTools ?? []).filter((n) => n !== "await_task" && n !== "check_task")
    const builtinNames = agent.builtins ?? []
    const allowedTools = [...new Set([...domainToolNames, ...infraTools, ...builtinNames])]
    const { toolMap } = runtime

    const toolPriorityHint = domainToolNames.length > 0 && builtinNames.length > 0
      ? `\n\nTool priority: always use domain tools first (${domainToolNames.join(", ")}). Fall back to built-in tools only when no domain tool can do the job.`
      : ""

    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: path.join(os.homedir(), ".pi", "agent"),
      systemPromptOverride: () => (agent.prompt ?? "") + toolPriorityHint,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
    })
    await resourceLoader.reload()
    const available = allowedTools.filter((name) => name in toolMap)
    const sessionOptions = {
      customTools: available.filter((n) => !builtinNames.includes(n)).map((name) => toolMap[name]!),
      tools: available,
      noTools: "builtin" as const,
      resourceLoader,
    }
    const sessionManager = runtime.cartridge.sessionManager?.(agent.name)
    logger.log(depth, agent.name, "START", { taskId, tools: sessionOptions.tools ?? [], prompt: params.prompt })
    const result = await (runtime.createSession ?? createAgentSession)({
      ...sessionOptions,
      ...(sessionManager ? { sessionManager } : {}),
      authStorage: ctx.modelRegistry.authStorage,
      modelRegistry: ctx.modelRegistry,
    })
    child = result.session
  }

  function extractResult(): string {
    const assistantTexts = child.messages
      .filter((m: any) => m.role === "assistant")
      .flatMap((m: any) => m.content.filter((c: any) => c.type === "text").map((c: any) => c.text.trim()).filter(Boolean))
    if (assistantTexts.length > 0) return assistantTexts[assistantTexts.length - 1]!
    const toolCalls = child.messages
      .filter((m: any) => m.role === "assistant")
      .flatMap((m: any) => m.content.filter((c: any) => c.type === "toolCall"))
      .map((c: any) => c.name)
    return toolCalls.length > 0
      ? `Completed. Tools used: ${[...new Set(toolCalls)].join(", ")}.`
      : "Completed with no output."
  }

  const session = new Session({
    taskId,
    nodeId,
    agentName: agent.name,
    depth,
    parent,
    promptFn: (msg: string) => child.prompt(msg),
    abortFn: () => void child.abort(),
    getResult: extractResult,
    getMessages: () => child.messages,
  })
  getRegistry().attach(session)

  const onAbort = () => void child.abort()
  if (signal?.aborted) onAbort()
  else signal?.addEventListener("abort", onAbort, { once: true })

  let lastLoggedSay = ""
  const unsubscribeChild = child.subscribe((event: any) => {
    if (session.status === "paused") return
    if (event.type === "tool_execution_start") {
      session.lastTool = event.toolName
      if (!session.toolsCalled.includes(event.toolName)) session.toolsCalled.push(event.toolName)
      emit({ type: "tool:start", nodeId, toolName: event.toolName, args: event.args })
      logger.log(depth + 1, agent.name, "TOOL", { tool: event.toolName, args: event.args })
    } else if (event.type === "tool_execution_end") {
      emit({ type: "tool:end", nodeId, toolName: event.toolName ?? "", isError: !!event.isError })
      logger.log(depth + 1, agent.name, event.isError ? "TOOL-ERR" : "TOOL-OUT", { tool: event.toolName, result: event.result })
    } else if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
      const msg = event.message
      if (msg?.role === "assistant") {
        const text = msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text ?? "").join("").trim()
        if (text && !text.startsWith("<task_result>")) {
          emit({ type: "agent:activity", nodeId, text })
          if (event.type === "message_end" && text !== lastLoggedSay) {
            logger.log(depth + 1, agent.name, "SAY", text)
            lastLoggedSay = text
          }
        }
      }
    }
  })

  session.setCleanup(() => {
    signal?.removeEventListener("abort", onAbort)
    unsubscribeChild()
    child.dispose()
  })

  emit({ type: "agent:start", nodeId, agentName: agent.name, isBackground: true, taskId })

  // pause doesn't abort anything, so a parent's already-in-flight turn keeps running right
  // after being paused and can still spawn a new child — that child is born after the
  // pauseSubtree() cascade already passed, so it would otherwise start out unfrozen. If the
  // parent is paused, start the child paused too, closing this gap (preserving pause's intent
  // of freezing "the current tree plus anything it spawns from here on").
  if (parent?.status === "paused") session.pause()

  trackerStore.run(session, () =>
    depthStore.run(depth + 1, () => child.prompt(params.prompt))
  )
    .then(() => session.checkDone())
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e)
      session.markError(msg)
    })

  return {
    content: [{ type: "text", text: JSON.stringify({ taskId, status: "running", agent: agent.name, instruction: "WAIT. Do NOT call await_task or check_task again for this task. Stop making tool calls and wait — the result arrives automatically as [task_complete] or [task_error]." }) }],
    details: { agent: agent.name },
  }
}

// ─── check_task tool ──────────────────────────────────────────────────────────

const CheckTaskParams = Type.Object({
  task_id: Type.String({ description: "The taskId returned by await_task(), e.g. 'bg-3'" }),
})

export const checkTaskTool = defineTool<typeof CheckTaskParams, {}>({
  name: "check_task",
  label: "Check Task",
  description: `Check the live status of a background sub-agent task — use at most ONCE per task.

Returns: taskId, agent, status ("active"|"waiting"|"paused"|"done"|"error"|"cancelled"), elapsedSec, currentMessage, lastTool, toolsCalled, childTasks.

AFTER calling check_task:
- status "active"/"waiting" → STOP making tool calls. Do NOT call check_task again for this task. The result arrives automatically as [task_complete] or [task_error]. Just tell the user the task is in progress and wait silently.
- status "done" / "error" → the task already finished; proceed with the result.

Calling check_task in a loop wastes tokens and context. One call is enough to confirm a task is running.`,
  parameters: CheckTaskParams,
  execute: (_id, params) => {
    const session = getRegistry().byTaskId(params.task_id)
    if (!session) {
      return Promise.resolve({
        content: [{ type: "text" as const, text: JSON.stringify({ error: "Task not found", task_id: params.task_id }) }],
        details: {},
      })
    }

    const texts = session.getMessages()
      .filter((m: any) => m.role === "assistant")
      .flatMap((m: any) => (m.content as any[]).filter((c) => c.type === "text").map((c) => (c.text ?? "").trim()))
      .filter(Boolean)
    const currentMessage = texts.at(-1)?.slice(-100)

    const elapsedSec = Math.round((Date.now() - session.startedAt) / 1000)

    const childTasks = getRegistry().childrenOf(session.agentName)
      .map((name) => getRegistry().byName(name)?.taskId)
      .filter((id): id is string => !!id)

    return Promise.resolve({
      content: [{
        type: "text" as const,
        text: JSON.stringify({ taskId: session.taskId, agent: session.agentName, status: session.status, elapsedSec, currentMessage, lastTool: session.lastTool, toolsCalled: session.toolsCalled, childTasks }),
      }],
      details: {},
    })
  },
  renderCall: (args: any, theme: any) =>
    new Text(`${theme.fg("toolTitle", theme.bold("check_task "))}${theme.fg("accent", args.task_id ?? "?")}`, 0, 0),
  renderResult: (result, _o, theme) => {
    const t = result.content[0]
    if (t?.type !== "text") return new Text(theme.fg("dim", "check_task"), 0, 0)
    try {
      const d = JSON.parse(t.text)
      if (d.error) return new Text(`${theme.fg("error", "☒")} ${theme.fg("dim", d.error)}`, 0, 0)
      const icon = d.status === "done" ? "✓" : d.status === "error" || d.status === "cancelled" ? "☒" : "●"
      const color = d.status === "done" ? "success" : d.status === "error" || d.status === "cancelled" ? "error" : "accent"
      return new Text(`${theme.fg(color, icon)} ${theme.fg("dim", `${d.agent} ${d.elapsedSec}s`)}`, 0, 0)
    } catch {
      return new Text(theme.fg("dim", "check_task"), 0, 0)
    }
  },
})

// ─── resume_child / cancel_child tools ─────────────────────────────────────────
//
// PI (interactive, callerName undefined → root only allowed) and every delegation-capable
// subagent (own direct children only allowed) share these same two tools — the caller is
// resolved automatically at execution time via trackerStore.getStore(), so no separate tool
// is needed per context.

const ResumeChildParams = Type.Object({
  child: Type.String({ description: "The exact agent name of the direct child to resume (must currently be paused)." }),
  instruction: Type.Optional(Type.String({ description: "Optional new instruction to inject when resuming." })),
})

export const resumeChildTool = defineTool<typeof ResumeChildParams, {}>({
  name: "resume_child",
  label: "Resume Child",
  description: `Resume ONE of your direct children that is currently paused, optionally injecting a new instruction.
This only resumes that one child — it does NOT cascade to its own children. If that child has paused descendants,
it must call resume_child itself once it resumes and decides to relay.`,
  parameters: ResumeChildParams,
  execute: async (_id, params) => {
    const callerName = trackerStore.getStore()?.agentName
    try {
      await getRegistry().resumeChild(callerName, params.child, params.instruction)
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }], details: {} }
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) }], details: {} }
    }
  },
})

const CancelChildParams = Type.Object({
  child: Type.String({ description: "The exact agent name of the direct child to cancel." }),
})

export const cancelChildTool = defineTool<typeof CancelChildParams, {}>({
  name: "cancel_child",
  label: "Cancel Child",
  description: `Cancel ONE of your direct children entirely, including everything running underneath it.
Unlike resume_child, cancellation always cascades to all of that child's descendants automatically.`,
  parameters: CancelChildParams,
  execute: async (_id, params) => {
    const callerName = trackerStore.getStore()?.agentName
    try {
      getRegistry().cancelChild(callerName, params.child)
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }], details: {} }
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) }], details: {} }
    }
  },
})

// ─── createTaskTools ──────────────────────────────────────────────────────────

const renderTaskCall = (args: any, theme: any) =>
  new Text(`${theme.fg("toolTitle", theme.bold(args.debug ? "task [DEBUG] " : "task "))}${theme.fg("accent", args.subagent_type ?? "?")}`, 0, 0)

const renderAwaitCall = (args: any, theme: any) =>
  new Text(`${theme.fg("toolTitle", theme.bold(args.debug ? "await_task [DEBUG] " : "await_task "))}${theme.fg("accent", args.subagent_type ?? "?")}`, 0, 0)

const renderResult = (result: { content: any[]; details?: TaskDetails }, _o: any, theme: any) => {
  const d = result.details
  if (d?.isError) return new Text(`${theme.fg("error", "☒")} ${theme.fg("dim", `${d.agent ?? "task"} failed`)}`, 0, 0)
  if (d?.agent) return new Text(`${theme.fg("success", "☑")} ${theme.fg("dim", `${d.agent} done`)}`, 0, 0)
  const t = result.content[0]
  return new Text(theme.fg("dim", t?.type === "text" ? t.text : "task"), 0, 0)
}

function makeParams(types: readonly string[], includeDebug = false) {
  const fields: Record<string, any> = {
    subagent_type: Type.Union(
      types.map((name) => Type.Literal(name)),
      { description: `The agent to delegate to. One of: ${types.join(", ")}` },
    ),
    description: Type.String({ description: "Short (3-5 word) description of the task" }),
    prompt: Type.String({ description: "Detailed instructions for the sub-agent" }),
  }
  if (includeDebug) {
    fields["debug"] = Type.Optional(
      Type.Boolean({ description: "Simulate the agent hierarchy without real LLM calls (3s delays per agent)." }),
    )
  }
  return Type.Object(fields)
}

export function createTaskTools(cartridge: Cartridge) {
  const allAgents = cartridge.agents
  const primaryNames = allAgents.filter((a) => a.mode === "primary").map((a) => a.name)
  const subagentNames = allAgents.filter((a) => a.mode === "subagent").map((a) => a.name)

  const defaultTaskDesc = `Delegate a request to the primary agent.
Set debug=true to simulate the full agent hierarchy without real LLM calls.`

  const defaultAwaitTaskDesc = `Spawn a sub-agent to handle a subtask. Returns immediately — result arrives as [task_complete].
Do NOT call await_task again for the same job; the result arrives automatically.`

  const PrimaryParams = makeParams(primaryNames, true)
  const taskTool = defineTool<typeof PrimaryParams, TaskDetails>({
    name: "task",
    label: "Task",
    description: cartridge.task?.description ?? defaultTaskDesc,
    ...(cartridge.task?.promptSnippet ? { promptSnippet: cartridge.task.promptSnippet } : {}),
    ...(cartridge.task?.promptGuidelines ? { promptGuidelines: cartridge.task.promptGuidelines } : {}),
    parameters: PrimaryParams,
    execute: (_id, params, signal, _onUpdate, ctx) => runTask(params as unknown as TaskArgs, signal, ctx),
    renderCall: renderTaskCall,
    renderResult,
  })

  const SubagentParams = makeParams(subagentNames)
  const awaitTaskTool = defineTool<typeof SubagentParams, TaskDetails>({
    name: "await_task",
    label: "Await Task",
    description: cartridge.awaitTask?.description ?? defaultAwaitTaskDesc,
    parameters: SubagentParams,
    execute: (_id, params, signal, _onUpdate, ctx) => runTask(params as unknown as TaskArgs, signal, ctx),
    renderCall: renderAwaitCall,
    renderResult,
  })

  return { taskTool, awaitTaskTool, checkTaskTool, resumeChildTool, cancelChildTool }
}
