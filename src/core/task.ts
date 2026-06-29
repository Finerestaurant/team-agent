import { createAgentSession, DefaultResourceLoader, defineTool } from "@earendil-works/pi-coding-agent"
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent"
import * as path from "node:path"
import * as os from "node:os"
import { Text } from "@earendil-works/pi-tui"
import { Type } from "typebox"
import { AsyncLocalStorage } from "node:async_hooks"
import type { Cartridge, AgentDef, TeamNode } from "../types.ts"
import * as logger from "./logger.ts"
import { emit } from "../ui/event-bus.ts"
import { pauseController } from "./pause.ts"

const depthStore = new AsyncLocalStorage<number>()

type SessionTracker = {
  nodeId: string
  agentName: string
  pendingCount: number
  prompt: (msg: string) => Promise<void>
  getResult: () => string
  notifyDone: (result: string) => void
  cleanup: () => void
  statusEntry?: TaskStatusEntry
}

const trackerStore = new AsyncLocalStorage<SessionTracker>()

// ─── Task status map ──────────────────────────────────────────────────────────

type TaskStatusEntry = {
  taskId: string
  agent: string
  status: "running" | "done" | "error"
  session: { messages: any[] } | null
  lastTool?: string
  toolsCalled: string[]
  childTasks: string[]
  startedAt: number
}

const taskStatusMap = new Map<string, TaskStatusEntry>()
let bgTaskCounter = 0

// ─── Runtime state ────────────────────────────────────────────────────────────

type Runtime = {
  cartridge: Cartridge
  toolMap: Record<string, ToolDefinition<any, any>>
  createSession?: (opts: any) => Promise<{ session: any }>
}

let runtime: Runtime | undefined
let agentMap: Map<string, AgentDef>

export function setRuntime(r: Runtime): void {
  runtime = r
  agentMap = new Map(r.cartridge.agents.map((a) => [a.name, a]))
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

  const parentTracker = trackerStore.getStore()
  if (parentTracker) parentTracker.pendingCount++

  const depth = depthStore.getStore() ?? 0
  const nodeId = crypto.randomUUID()
  const taskId = `bg-${++bgTaskCounter}`

  const statusEntry: TaskStatusEntry = {
    taskId,
    agent: agent.name,
    status: "running",
    session: null,
    lastTool: undefined,
    toolsCalled: [],
    childTasks: [],
    startedAt: Date.now(),
  }
  taskStatusMap.set(taskId, statusEntry)
  if (parentTracker?.statusEntry) parentTracker.statusEntry.childTasks.push(taskId)

  let child: Awaited<ReturnType<typeof makeDebugSession>>

  if (params.debug) {
    logger.log(depth, agent.name, "DEBUG START", { taskId })
    child = makeDebugSession(agent.name, nodeId, signal, ctx)
  } else {
    const infraTools = hasDelegationChildren(runtime.cartridge.team, agent.name)
      ? ["await_task", "check_task"]
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

  statusEntry.session = child

  pauseController.register(taskId, () => void child.abort())
  const onAbort = () => void child.abort()
  if (signal?.aborted) onAbort()
  else signal?.addEventListener("abort", onAbort, { once: true })

  let lastLoggedSay = ""
  const unsubscribeChild = child.subscribe((event: any) => {
    if (pauseController.isPaused) return
    if (event.type === "tool_execution_start") {
      statusEntry.lastTool = event.toolName
      if (!statusEntry.toolsCalled.includes(event.toolName)) statusEntry.toolsCalled.push(event.toolName)
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

  emit({ type: "agent:start", nodeId, agentName: agent.name, isBackground: true, taskId })

  let done = false

  const tracker: SessionTracker = {
    nodeId,
    agentName: agent.name,
    pendingCount: 0,
    prompt: (msg: string) => child.prompt(msg),
    getResult: extractResult,
    statusEntry,
    cleanup: () => {
      pauseController.unregister(taskId)
      signal?.removeEventListener("abort", onAbort)
      unsubscribeChild()
      child.dispose()
      setTimeout(() => taskStatusMap.delete(taskId), 60_000)
    },
    notifyDone: (result: string) => {
      if (done) return
      done = true
      statusEntry.status = "done"
      statusEntry.session = null
      emit({ type: "agent:end", nodeId, agentName: agent.name, status: "done", isBackground: true, taskId, result })
      logger.log(depth, agent.name, "DONE", { taskId, result: result.slice(0, 200) })
      tracker.cleanup()

      if (parentTracker && !pauseController.isPaused) {
        parentTracker.pendingCount--
        emit({ type: "agent:resumed", nodeId: parentTracker.nodeId, agentName: parentTracker.agentName })
        trackerStore.run(parentTracker, () =>
          parentTracker.prompt(`[task_complete] ${agent.name} done:\n${result}`)
        )
          .then(() => checkDone(parentTracker))
          .catch((e) => {
            logger.log(depth, agent.name, "PARENT-RESUME-ERROR", { error: e instanceof Error ? e.message : String(e) })
          })
      }
    },
  }

  function checkDone(t: SessionTracker): void {
    if (t.pendingCount === 0) t.notifyDone(t.getResult())
    else emit({ type: "agent:waiting", nodeId: t.nodeId, agentName: t.agentName })
  }

  trackerStore.run(tracker, () =>
    depthStore.run(depth + 1, () => child.prompt(params.prompt))
  )
    .then(() => checkDone(tracker))
    .catch((e) => {
      if (done) return
      done = true
      const msg = e instanceof Error ? e.message : String(e)
      statusEntry.status = "error"
      statusEntry.session = null
      emit({ type: "agent:end", nodeId, agentName: agent.name, status: "error", isBackground: true, taskId, result: msg })
      logger.log(depth, agent.name, "ERROR", { taskId, error: msg })
      tracker.cleanup()
      if (parentTracker && !pauseController.isPaused) {
        parentTracker.pendingCount--
        emit({ type: "agent:resumed", nodeId: parentTracker.nodeId, agentName: parentTracker.agentName })
        trackerStore.run(parentTracker, () =>
          parentTracker.prompt(`[task_error] ${agent.name} error:\n${msg}`)
        )
          .then(() => checkDone(parentTracker))
          .catch(() => {})
      }
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

Returns: taskId, agent, status ("running"|"done"|"error"), elapsedSec, currentMessage, lastTool, toolsCalled, childTasks.

AFTER calling check_task:
- status "running" → STOP making tool calls. Do NOT call check_task again for this task. The result arrives automatically as [task_complete] or [task_error]. Just tell the user the task is in progress and wait silently.
- status "done" / "error" → the task already finished; proceed with the result.

Calling check_task in a loop wastes tokens and context. One call is enough to confirm a task is running.`,
  parameters: CheckTaskParams,
  execute: (_id, params) => {
    const entry = taskStatusMap.get(params.task_id)
    if (!entry) {
      return Promise.resolve({
        content: [{ type: "text" as const, text: JSON.stringify({ error: "Task not found", task_id: params.task_id }) }],
        details: {},
      })
    }

    let currentMessage: string | undefined
    if (entry.session) {
      const texts = (entry.session.messages as any[])
        .filter((m) => m.role === "assistant")
        .flatMap((m) =>
          (m.content as any[]).filter((c) => c.type === "text").map((c) => (c.text ?? "").trim())
        )
        .filter(Boolean)
      const last = texts.at(-1)
      if (last) currentMessage = last.slice(-100)
    }

    const elapsedSec = Math.round((Date.now() - entry.startedAt) / 1000)

    return Promise.resolve({
      content: [{
        type: "text" as const,
        text: JSON.stringify({ taskId: entry.taskId, agent: entry.agent, status: entry.status, elapsedSec, currentMessage, lastTool: entry.lastTool, toolsCalled: entry.toolsCalled, childTasks: entry.childTasks }),
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
      const icon = d.status === "running" ? "●" : d.status === "done" ? "✓" : "☒"
      const color = d.status === "running" ? "accent" : d.status === "done" ? "success" : "error"
      return new Text(`${theme.fg(color, icon)} ${theme.fg("dim", `${d.agent} ${d.elapsedSec}s`)}`, 0, 0)
    } catch {
      return new Text(theme.fg("dim", "check_task"), 0, 0)
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

  return { taskTool, awaitTaskTool, checkTaskTool }
}
