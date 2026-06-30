import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  defineTool,
} from "@earendil-works/pi-coding-agent"
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent"
import { truncateToWidth, visibleWidth, Editor, Key, matchesKey } from "@earendil-works/pi-tui"
import type { Component, TUI, KeybindingsManager, EditorTheme } from "@earendil-works/pi-tui"
import { Type } from "typebox"
import * as fs from "node:fs"
import * as pathLib from "node:path"
import * as os from "node:os"
import type { TeamNode } from "../../types.ts"
import * as logger from "../../core/logger.ts"
import { emit } from "../../ui/event-bus.ts"
import * as panel from "../../ui/panel.ts"
import { CartridgeDraft } from "./codegen.ts"
import type { ToolDef, ToolParam } from "./codegen.ts"
import type { AgentDef } from "../../types.ts"

const CARTRIDGE_DIR = pathLib.join(
  pathLib.dirname(new URL(import.meta.url).pathname),
  "../../..",
  "cartridge",
)

// ─── Types ────────────────────────────────────────────────────────────────────

type ConvEntry = { type: "q" | "a"; text: string }

type WizardPhase =
  | { kind: "input" }
  | { kind: "thinking" }
  | { kind: "confirm"; plan: CartridgeDraft }
  | { kind: "done"; plan: CartridgeDraft }

// ─── Prompts ──────────────────────────────────────────────────────────────────

const PLANNER_SYSTEM = `You are a team-agent cartridge architect. You MUST respond exclusively with tool calls — never with text or markdown.

CRITICAL: Any text response (including explanations, summaries, or "here is my plan") is a failure. Every turn must be one or more tool calls, nothing else.

Required sequence — follow this exactly:
1. Call ask_user if you need to clarify the team's purpose (optional, max 2 times)
2. Call ask_user to propose the cartridge metadata and wait for user approval before proceeding
3. Call define_cartridge with the approved title, description, and task guidance
4. Call add_agent for every agent — always add parent before children; root agent has parent: null
5. Call add_tool for each domain tool (skip if none needed)

define_cartridge argument guide:
- task_description: shown in pi's tool list — specify exactly when/how pi must invoke task()
- task_prompt_snippet: one concise line injected into pi's system prompt describing the active team
- task_prompt_guidelines: 1-2 strict behavioral rules for pi (e.g. "Always delegate via task() — never answer directly")

add_agent argument guide:
- name: snake_case unique identifier
- parent: name of an already-added agent; null for the root agent only
- mode: "primary" for root, "subagent" for all others
- domainTools: only tool names registered via add_tool
- builtins: pi built-in tools this agent may use — ["shell", "read_file", "list_directory"]

add_tool argument guide:
- Domain tools are for external I/O only (file, HTTP, database, process)
- Do not create tools for tasks the LLM can handle directly
- implementation: concrete description of what code to write

After calling add_tool (or add_agent if no tools), your work is complete. Do NOT call ask_user again. Stop immediately — the session closes automatically.

Start immediately with the first tool call.`

// ─── Planner state & tools ────────────────────────────────────────────────────

type PlannerHandle = {
  session: any
  nodeId: string
  reset: () => void
  getPlan: () => CartridgeDraft | undefined
  setOnTree: (cb: (tree: TeamNode | undefined) => void) => void
}

function makePlannerState(
  askUser: (q: string) => Promise<string | null>,
  onStatus: (text: string) => void,
  initialOnTree: (tree: TeamNode | undefined) => void,
) {
  let onTree = initialOnTree
  function setOnTree(cb: (tree: TeamNode | undefined) => void) { onTree = cb }
  const draft = new CartridgeDraft()
  let cancelled = false

  function reset() {
    draft.reset()
    onTree(undefined)
  }

  function getPlan(): CartridgeDraft | undefined {
    return draft.isReady() ? draft : undefined
  }

  const AskParams = Type.Object({ question: Type.String() })
  const DefineCartridgeParams = Type.Object({
    title: Type.String({ description: "kebab-case cartridge name" }),
    description: Type.String({ description: "one-sentence description" }),
    task_description: Type.String({ description: "shown in pi's tool list — when/how pi must call task()" }),
    task_prompt_snippet: Type.String({ description: "one line injected into pi's system prompt" }),
    task_prompt_guidelines: Type.Array(Type.String(), { description: "strict rules injected into pi's system prompt" }),
  })
  const AddAgentParams = Type.Object({
    name: Type.String({ description: "snake_case identifier" }),
    label: Type.String({ description: "display name" }),
    parent: Type.Union([Type.String(), Type.Null()], { description: "parent agent name, null for root" }),
    mode: Type.Union([Type.Literal("primary"), Type.Literal("subagent")]),
    description: Type.String(),
    prompt: Type.String({ description: "agent system prompt" }),
    tools: Type.Array(Type.String(), { description: "domain tool names this agent can use" }),
    builtins: Type.Optional(Type.Array(Type.String(), { description: "pi built-in tools to allow (e.g. shell, read_file, list_directory)" })),
  })
  const AddToolParams = Type.Object({
    name: Type.String({ description: "kebab-case identifier" }),
    description: Type.String(),
    parameters: Type.Array(Type.Object({
      name: Type.String(),
      type: Type.String({ description: "string | number | boolean | string[] | union like 'add'|'lookup'|'list'" }),
      description: Type.String(),
      optional: Type.Optional(Type.Boolean()),
    }), { description: "list of input parameters for this tool" }),
    implementation: Type.String({ description: "implementation method — e.g. store in ~/.team-agent/<name>.json, call HTTP GET /api/xxx" }),
  })

  const tools = [
    defineTool<typeof AskParams, {}>({
      name: "ask_user", label: "Ask User",
      description: "ask the user a clarification question",
      parameters: AskParams,
      execute: async (_id, { question }) => {
        logger.log(1, "wizard", "ask_user:question", question)
        const answer = await askUser(question)
        logger.log(1, "wizard", "ask_user:answer", answer ?? "(cancelled)")
        if (answer === null) {
          if (draft.isReady()) return { content: [{ type: "text" as const, text: "" }], details: {} }
          cancelled = true
          throw new Error("WIZARD_CANCELLED")
        }
        return { content: [{ type: "text" as const, text: answer }], details: {} }
      },
    }),
    defineTool<typeof DefineCartridgeParams, {}>({
      name: "define_cartridge", label: "Define Cartridge",
      description: "set cartridge metadata and how pi should use the task tool — call after user confirms",
      parameters: DefineCartridgeParams,
      execute: (_id, { title, description, task_description, task_prompt_snippet, task_prompt_guidelines }) => {
        draft.title = title
        draft.description = description
        draft.task.description = task_description
        draft.task.promptSnippet = task_prompt_snippet
        draft.task.promptGuidelines = task_prompt_guidelines
        logger.log(0, "wizard", "define_cartridge", { title, guidelines: task_prompt_guidelines.length })
        return Promise.resolve({ content: [{ type: "text" as const, text: `✓ "${title}" defined` }], details: {} })
      },
    }),
    defineTool<typeof AddAgentParams, {}>({
      name: "add_agent", label: "Add Agent",
      description: "add an agent to the team",
      parameters: AddAgentParams,
      execute: (_id, { name, label, parent, mode, description, prompt, tools: agentTools, builtins }) => {
        const err = draft.addAgent({ name, label, parent: parent ?? null, mode, description, prompt, domainTools: agentTools, builtins })
        if (err) logger.log(1, "wizard", "add_agent:error", { name, err })
        else logger.log(1, "wizard", "add_agent", { name, parent, mode })
        onTree(draft.team)
        return Promise.resolve({ content: [{ type: "text" as const, text: err ? `✗ ${err}` : `✓ ${name}` }], details: {} })
      },
    }),
    defineTool<typeof AddToolParams, {}>({
      name: "add_tool", label: "Add Tool",
      description: "define a domain tool",
      parameters: AddToolParams,
      execute: (_id, { name, description, parameters, implementation }) => {
        draft.addTool({ name, description, parameters: parameters ?? [], implementation: implementation ?? "" })
        logger.log(1, "wizard", "add_tool", { name, params: parameters?.length ?? 0 })
        return Promise.resolve({ content: [{ type: "text" as const, text: `✓ ${name}` }], details: {} })
      },
    }),
  ]

  return { tools, reset, getPlan, setOnTree, get cancelled() { return cancelled } }
}

function renderPlanTree(
  node: TeamNode,
  theme: Theme,
  prefix: string,
  isRoot: boolean,
  isLast: boolean,
  lines: string[],
  builtSet?: Set<string>,
  agentMap?: Map<string, AgentDef>,
): void {
  const connector = isRoot ? "" : theme.fg("dim", isLast ? "└─ " : "├─ ")
  const contPrefix = isRoot ? prefix : prefix + theme.fg("dim", isLast ? "   " : "│  ")
  const built = builtSet?.has(node.name)
  const marker = built ? theme.fg("success", "✓") : theme.fg("dim", "□")
  const label = built ? theme.fg("success", node.label) : theme.fg("dim", node.label)
  const tools = agentMap?.get(node.name)?.domainTools ?? []
  const toolSuffix = tools.length > 0
    ? "  " + theme.fg("dim", "[" + tools.join(", ") + "]")
    : ""
  lines.push(`${prefix}${connector}${marker} ${label}${toolSuffix}`)
  node.children.forEach((child, i) => {
    renderPlanTree(child, theme, contPrefix, false, i === node.children.length - 1, lines, builtSet, agentMap)
  })
}

function scaffoldStatic(destDir: string, name: string, relTeamAgent: string): void {
  const pkg = {
    name: `@team-agent/${name}`,
    version: "0.1.0",
    type: "module",
    description: `${name} cartridge for team-agent`,
    dependencies: { "team-agent": relTeamAgent },
    peerDependencies: {
      "@earendil-works/pi-coding-agent": "*",
      "@earendil-works/pi-tui": "*",
      typebox: "*",
    },
    peerDependenciesMeta: {
      "@earendil-works/pi-coding-agent": { optional: true },
      "@earendil-works/pi-tui": { optional: true },
      typebox: { optional: true },
    },
    devDependencies: {
      "@earendil-works/pi-coding-agent": "^0.79.9",
      "@earendil-works/pi-tui": "^0.79.9",
      typebox: "^1.1.38",
      "bun-types": "latest",
      typescript: "^5.8.3",
    },
  }
  const tsconfig = {
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "bundler",
      lib: ["ESNext"],
      strict: true,
      verbatimModuleSyntax: true,
      allowImportingTsExtensions: true,
      types: ["bun-types"],
      skipLibCheck: true,
      paths: { "team-agent": [`${relTeamAgent}/src/index.ts`] },
    },
    include: ["src/**/*"],
  }
  fs.mkdirSync(destDir, { recursive: true })
  fs.writeFileSync(pathLib.join(destDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n")
  fs.writeFileSync(pathLib.join(destDir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2) + "\n")

  const linkPath = pathLib.join(destDir, "node_modules", "team-agent")
  if (!fs.existsSync(linkPath)) {
    fs.mkdirSync(pathLib.dirname(linkPath), { recursive: true })
    fs.symlinkSync(pathLib.resolve(destDir, relTeamAgent), linkPath)
  }
}

async function installAndActivate(
  plan: CartridgeDraft,
  destDir: string,
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  fs.writeFileSync(pathLib.join(CARTRIDGE_DIR, ".active"), plan.title)
  const mod = await import(pathLib.join(destDir, "src", "index.ts"))
  if (typeof mod.default === "function") {
    mod.default(pi)
    panel.bindUI(ctx)
  }
}

// ─── Planner agent ────────────────────────────────────────────────────────────

async function runPlanner(
  ctx: ExtensionCommandContext,
  initialMessage: string,
  askUser: (question: string) => Promise<string | null>,
  onStatus: (text: string) => void,
  onTree: (tree: TeamNode | undefined) => void,
): Promise<PlannerHandle | "cancelled" | undefined> {
  const nodeId = crypto.randomUUID()
  logger.log(0, "wizard", "planner:start", { initialMessage })
  emit({ type: "agent:start", nodeId, agentName: "cartridge-planner", isBackground: true })

  const state = makePlannerState(askUser, onStatus, onTree)

  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: pathLib.join(os.homedir(), ".pi", "agent"),
    systemPromptOverride: () => PLANNER_SYSTEM,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
  })
  await resourceLoader.reload()

  const { session } = await createAgentSession({
    customTools: state.tools,
    tools: ["ask_user", "define_cartridge", "add_agent", "add_tool"],
    noTools: "builtin",
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
    authStorage: ctx.modelRegistry.authStorage,
    modelRegistry: ctx.modelRegistry,
  })

  let lastLoggedLen = 0
  session.subscribe((event: any) => {
    if (event.type === "message_update" && event.message?.role === "assistant") {
      const text = event.message.content
        ?.filter((b: any) => b.type === "text")
        .map((b: any) => b.text as string)
        .join("")
        .replace(/\s+/g, " ")
        .trim()
      if (text && text.length - lastLoggedLen >= 100) {
        logger.log(1, "wizard", "planner:thinking", text.slice(0, 300))
        lastLoggedLen = text.length
      }
    }
  })

  try {
    await session.prompt(initialMessage)
    if (state.cancelled) {
      logger.log(0, "wizard", "planner:cancelled")
      emit({ type: "agent:end", nodeId, agentName: "cartridge-planner", status: "done", isBackground: true })
      session.dispose()
      return "cancelled"
    }
    const plan = state.getPlan()
    if (!plan) {
      logger.log(0, "wizard", "planner:no-plan", "finish tool was not called")
      emit({ type: "agent:end", nodeId, agentName: "cartridge-planner", status: "error", isBackground: true })
      session.dispose()
      return undefined
    }
    logger.log(0, "wizard", "planner:done", { title: plan.title, agents: plan.agents.length })
    emit({ type: "agent:end", nodeId, agentName: "cartridge-planner", status: "done", isBackground: true })
    return { session, nodeId, reset: state.reset, getPlan: state.getPlan, setOnTree: state.setOnTree }
  } catch (e) {
    const isCancelled = state.cancelled || (e instanceof Error && e.message === "WIZARD_CANCELLED")
    logger.log(0, "wizard", isCancelled ? "planner:cancelled" : "planner:error", e instanceof Error ? e.stack ?? e.message : String(e))
    emit({ type: "agent:end", nodeId, agentName: "cartridge-planner", status: isCancelled ? "done" : "error", isBackground: true })
    session.dispose()
    return isCancelled ? "cancelled" : undefined
  }
}

function buildRefinePrompt(draft: CartridgeDraft, instructions: string): string {
  const agentLines = draft.agents.map((a) =>
    `  - ${a.name} (${a.mode}): tools=[${(a.domainTools ?? []).join(", ")}]`
  ).join("\n")
  const toolLines = draft.tools.map((t) =>
    `  - ${t.name}: ${t.description}`
  ).join("\n")
  return `Current team configuration:
title: "${draft.title}"
task_description: "${draft.task.description}"
agents:
${agentLines || "  (none)"}
tools:
${toolLines || "  (none)"}

Modification request: ${instructions}

Apply the modification. Preserve existing names where possible.
Rebuild the full configuration in define_cartridge → add_agent → add_tool order.`
}

async function refinePlan(
  handle: PlannerHandle,
  currentPlan: CartridgeDraft,
  instructions: string,
  askUser: (question: string) => Promise<string | null>,
  onStatus: (text: string) => void,
  onTree: (tree: TeamNode | undefined) => void,
): Promise<CartridgeDraft | "cancelled" | undefined> {
  logger.log(0, "wizard", "refine:start", instructions)
  emit({ type: "agent:start", nodeId: handle.nodeId, agentName: "cartridge-planner", isBackground: true })

  handle.setOnTree(onTree)
  handle.reset()

  const customTools: any[] = (handle.session as any)._customTools ?? []
  const askTool = customTools.find((t: any) => t.name === "ask_user")
  const origExecute = askTool?.execute
  if (askTool) {
    askTool.execute = async (_id: string, { question }: { question: string }) => {
      logger.log(1, "wizard", "refine:ask_user:question", question)
      const answer = await askUser(question)
      logger.log(1, "wizard", "refine:ask_user:answer", answer ?? "(cancelled)")
      if (answer === null) throw new Error("WIZARD_CANCELLED")
      return { content: [{ type: "text" as const, text: answer }], details: {} }
    }
  }

  try {
    await handle.session.prompt(buildRefinePrompt(currentPlan, instructions))
    if (askTool && origExecute) askTool.execute = origExecute
    const plan = handle.getPlan()
    logger.log(0, "wizard", plan ? "refine:done" : "refine:no-plan", plan ? { title: plan.title, agents: plan.agents.length } : undefined)
    emit({ type: "agent:end", nodeId: handle.nodeId, agentName: "cartridge-planner", status: plan ? "done" : "error", isBackground: true })
    return plan ?? undefined
  } catch (e) {
    if (askTool && origExecute) askTool.execute = origExecute
    const isCancelled = e instanceof Error && e.message === "WIZARD_CANCELLED"
    logger.log(0, "wizard", isCancelled ? "refine:cancelled" : "refine:error", e instanceof Error ? e.stack ?? e.message : String(e))
    emit({ type: "agent:end", nodeId: handle.nodeId, agentName: "cartridge-planner", status: isCancelled ? "done" : "error", isBackground: true })
    return isCancelled ? "cancelled" : undefined
  }
}

// ─── Wizard UI — single ctx.ui.custom ─────────────────────────────────────────

const CONFIRM_CHOICES = [
  ["create", "✓  Create as-is"],
  ["chat",   "✦  Refine (chat about this)"],
  ["cancel", "✕  Cancel"],
] as const

export async function handleCreateCartridge(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  await ctx.ui.custom<void>((tui: TUI, theme: Theme, _kb: KeybindingsManager, done: (v: void) => void) => {
    // ── State ────────────────────────────────────────────
    const conv: ConvEntry[] = []
    let phase: WizardPhase = { kind: "input" }
    let confirmCursor = 0
    let resolveInput: ((v: string | null) => void) | null = null
    let confirmResolve: ((choice: "create" | "chat" | "cancel") => void) | null = null
    let cachedLines: string[] | undefined
    let statusText: string | undefined
    let lastPlan: CartridgeDraft | undefined
    let liveTree: TeamNode | undefined
    let builtAgents = new Set<string>()
    let isBuilding = false
    let closed = false
    function safeDone() { if (!closed) { closed = true; done(undefined) } }

    const editorTheme: EditorTheme = {
      borderColor: (s) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      },
    }
    const editor = new Editor(tui, editorTheme)

    // ── Helpers ───────────────────────────────────────────
    function refresh() { cachedLines = undefined; tui.requestRender() }

    function addEntry(e: ConvEntry): void { conv.push(e); refresh() }
    function setStatus(text: string | undefined): void { statusText = text; refresh() }

    function waitForInput(question: string): Promise<string | null> {
      addEntry({ type: "q", text: question })
      editor.setText("")
      phase = { kind: "input" }
      refresh()
      return new Promise((resolve) => { resolveInput = resolve })
    }

    function submitInput(value: string | null): void {
      const r = resolveInput
      if (!r) return
      resolveInput = null
      if (value !== null && value.trim()) addEntry({ type: "a", text: value })
      phase = { kind: "thinking" }
      refresh()
      r(value)
    }

    function waitForConfirm(plan: CartridgeDraft): Promise<"create" | "chat" | "cancel"> {
      lastPlan = plan
      confirmCursor = 0
      phase = { kind: "confirm", plan }
      refresh()
      return new Promise((resolve) => { confirmResolve = resolve })
    }

    editor.onSubmit = (text) => submitInput(text.trim() || null)

    // ── Spinner frames ────────────────────────────────────
    const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

    // ── Component ─────────────────────────────────────────
    const component: Component & { dispose?(): void } = {
      render(width: number): string[] {
        if (cachedLines) return cachedLines

        const leftFixed = "─────── "
        const LABEL = "✦ New Cartridge Wizard"
        const trailing = Math.max(0, width - leftFixed.length - LABEL.length - 1)
        const topHr = theme.fg("border", leftFixed + LABEL + " " + "─".repeat(trailing))
        const bottomHr = theme.fg("border", "─".repeat(Math.max(1, width)))
        const lines: string[] = [topHr, ""]

        for (const e of conv) {
          if (e.type === "q") {
            const qlines = e.text.split("\n")
            lines.push(` ${theme.fg("dim", "?")} ${qlines[0] ?? ""}`)
            for (const ql of qlines.slice(1)) {
              if (ql.trim()) lines.push(`   ${theme.fg("dim", ql)}`)
            }
          } else if (e.type === "a") {
            for (const al of e.text.split("\n")) {
              if (al.trim()) lines.push(` ${theme.fg("accent", "›")} ${al}`)
            }
            lines.push("")
          }
        }

        if (phase.kind === "thinking" && liveTree) {
          lines.push("")
          const spin = theme.fg("accent", SPIN[Math.floor(Date.now() / 80) % SPIN.length]!)
          const sectionLabel = isBuilding ? "building" : "designing"
          const label = ` ${spin} ${theme.fg("dim", sectionLabel)} `
          const used = 2 + visibleWidth(label)
          const tail = theme.fg("dim", "─".repeat(Math.max(0, width - used)))
          lines.push(` ${theme.fg("dim", "─")}${label}${tail}`)
          const treeLines: string[] = []
          renderPlanTree(liveTree, theme, "", true, true, treeLines, isBuilding ? builtAgents : undefined)
          for (const l of treeLines) lines.push(` ${l}`)
          lines.push(` ${theme.fg("dim", "─".repeat(Math.max(1, width - 2)))}`)
        }

        // Status always at the bottom
        if (statusText && !(phase.kind === "thinking" && liveTree)) {
          const spin = phase.kind === "thinking"
            ? theme.fg("accent", SPIN[Math.floor(Date.now() / 80) % SPIN.length]!)
            : theme.fg("dim", "·")
          lines.push("")
          lines.push(` ${spin} ${theme.fg("dim", statusText)}`)
        }

        if (phase.kind === "input") {
          if (lastPlan?.team) {
            const lastAgentMap = new Map(lastPlan.agents.map((a) => [a.name, a]))
            lines.push(` ${theme.fg("toolTitle", theme.bold(lastPlan.title))}  ${theme.fg("dim", lastPlan.description)}`)
            lines.push("")
            const treeLines: string[] = []
            renderPlanTree(lastPlan.team, theme, "", true, true, treeLines, undefined, lastAgentMap)
            for (const l of treeLines) lines.push(` ${l}`)
            lines.push("")
          }
          for (const l of editor.render(width - 2)) lines.push(` ${l}`)
          lines.push("")
          lines.push(` ${theme.fg("border", "enter")} ${theme.fg("dim", "submit")}  ${theme.fg("border", "esc")} ${theme.fg("dim", "cancel")}`)
        } else if (phase.kind === "confirm") {
          const { plan } = phase
          const agentMap = new Map(plan.agents.map((a) => [a.name, a]))
          lines.push(` ${theme.fg("toolTitle", theme.bold(plan.title))}  ${theme.fg("dim", plan.description)}`)
          lines.push("")
          const treeLines: string[] = []
          if (plan.team) renderPlanTree(plan.team, theme, "", true, true, treeLines, undefined, agentMap)
          for (const l of treeLines) lines.push(` ${l}`)
          lines.push("")
          lines.push(` ${theme.fg("dim", `${plan.agents.length} agents  ${plan.tools.length} tools`)}`)
          if (plan.tools.length > 0) {
            lines.push("")
            lines.push(` ${theme.fg("warning", "⚠")} ${theme.fg("dim", "these tools need implementation after install:")}`)
            for (const t of plan.tools) {
              lines.push(`   ${theme.fg("warning", t.name)}  ${theme.fg("dim", t.implementation)}`)
            }
          }
          lines.push("")
          for (let i = 0; i < CONFIRM_CHOICES.length; i++) {
            const [, label] = CONFIRM_CHOICES[i]!
            lines.push(
              i === confirmCursor
                ? ` ${theme.fg("accent", "→")} ${theme.fg("accent", theme.bold(label))}`
                : `   ${theme.fg("dim", label)}`,
            )
          }
          lines.push("")
          lines.push(` ${theme.fg("border", "↑↓")} ${theme.fg("dim", "move")}  ${theme.fg("border", "enter")} ${theme.fg("dim", "select")}  ${theme.fg("border", "esc")} ${theme.fg("dim", "cancel")}`)
        } else if (phase.kind === "done") {
          const { plan } = phase
          lines.push(` ${theme.fg("success", "✓")} ${theme.fg("success", theme.bold(plan.title))}  ${theme.fg("dim", plan.description)}`)
          lines.push("")
          const treeLines: string[] = []
          if (plan.team) renderPlanTree(plan.team, theme, "", true, true, treeLines, builtAgents)
          for (const l of treeLines) lines.push(` ${l}`)
          lines.push("")
          lines.push(` ${theme.fg("dim", `${plan.agents.length} agents  ${plan.tools.length} tools  — cartridge activated`)}`)
          if (plan.tools.length > 0) {
            lines.push("")
            lines.push(` ${theme.fg("warning", "⚠")} ${theme.fg("dim", `${plan.tools.length} tools need execute implementation — see SETUP.md`)}`)
          }
          lines.push("")
          lines.push(` ${theme.fg("border", "enter")} ${theme.fg("dim", "close")}  ${theme.fg("border", "esc")} ${theme.fg("dim", "close")}`)
        }

        lines.push(bottomHr)
        cachedLines = lines.map((l) => truncateToWidth(l, width, "…"))
        return cachedLines
      },

      handleInput(data: string): void {
        if (matchesKey(data, Key.escape)) {
          resolveInput?.(null); resolveInput = null
          confirmResolve?.("cancel"); confirmResolve = null
          safeDone()
          return
        }
        if (phase.kind === "done") {
          if (matchesKey(data, Key.enter)) safeDone()
          return
        }
        if (phase.kind === "input") {
          editor.handleInput(data)
          refresh()
        } else if (phase.kind === "confirm") {
          if (matchesKey(data, Key.up)) {
            confirmCursor = (confirmCursor - 1 + CONFIRM_CHOICES.length) % CONFIRM_CHOICES.length
            refresh()
          } else if (matchesKey(data, Key.down)) {
            confirmCursor = (confirmCursor + 1) % CONFIRM_CHOICES.length
            refresh()
          } else if (matchesKey(data, Key.enter)) {
            const r = confirmResolve; confirmResolve = null; r?.(CONFIRM_CHOICES[confirmCursor]![0])
          }
        }
      },

      invalidate(): void { cachedLines = undefined; editor.invalidate() },

      dispose() { clearInterval(spinTimer) },
    }

    // ── Spinner for thinking/status ───────────────────────
    const spinTimer = setInterval(() => {
      if (phase.kind === "thinking" || statusText) {
        cachedLines = undefined
        tui.requestRender()
      }
    }, 80)

    // ── Async wizard flow ─────────────────────────────────
    ;(async () => {
      try {
        logger.log(0, "wizard", "start")
        const description = await waitForInput("What kind of team do you want to build?")
        if (!description) { logger.log(0, "wizard", "cancelled:initial-input"); safeDone(); return }
        logger.log(0, "wizard", "user:description", description)

        setStatus("Designing team structure...")

        const plannerResult = await runPlanner(ctx, description, (q) => waitForInput(q), (t) => setStatus(t), (tree) => { liveTree = tree; refresh() })

        if (plannerResult === "cancelled") { safeDone(); return }
        if (!plannerResult) {
          logger.log(0, "wizard", "planner-result:undefined")
          setStatus("Error: planner did not complete the team design (finish tool not called)")
          await new Promise((r) => setTimeout(r, 3000))
          safeDone()
          return
        }

        const handle = plannerResult
        let plan = handle.getPlan()!
        plan.title = plan.title
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "-")
          .replace(/--+/g, "-")
          .replace(/^-|-$/g, "")

        if (!plan.title) {
          setStatus("Error: invalid cartridge name")
          await new Promise((r) => setTimeout(r, 2000))
          safeDone()
          return
        }

        const destDir = pathLib.join(CARTRIDGE_DIR, plan.title)
        if (fs.existsSync(destDir)) {
          setStatus(`Error: "${plan.title}" already exists`)
          await new Promise((r) => setTimeout(r, 2000))
          safeDone()
          return
        }

        // Confirm loop
        setStatus(undefined)
        while (true) {
          const choice = await waitForConfirm(plan)

          if (choice === "cancel") { logger.log(0, "wizard", "user:cancel"); safeDone(); return }

          if (choice === "chat") {
            const instructions = await waitForInput("How would you like to modify it?")
            if (!instructions) { logger.log(0, "wizard", "cancelled:refine-input"); safeDone(); return }
            logger.log(0, "wizard", "user:refine-instructions", instructions)
            setStatus("Refining...")
            const refined = await refinePlan(handle, plan, instructions, (q) => waitForInput(q), (t) => setStatus(t), (tree) => { liveTree = tree; refresh() })
            if (refined === "cancelled") { safeDone(); return }
            if (!refined) {
              logger.log(0, "wizard", "refine-result:undefined")
              setStatus("Refinement failed — reverting to previous team structure")
              await new Promise((r) => setTimeout(r, 2000))
              setStatus(undefined)
              liveTree = lastPlan?.team
              continue
            }
            plan = refined
            setStatus(undefined)
            continue
          }

          break // "create"
        }

        // Build
        builtAgents = new Set<string>()
        isBuilding = true
        liveTree = plan.team
        phase = { kind: "thinking" }
        setStatus("Writing files...")

        const teamAgentDir = pathLib.join(CARTRIDGE_DIR, "..")
        scaffoldStatic(destDir, plan.title, pathLib.relative(destDir, teamAgentDir))

        await plan.saveAsCode(destDir, (text) => setStatus(text), (name) => {
          builtAgents.add(name)
          refresh()
        })

        setStatus("Installing...")
        await installAndActivate(plan, destDir, pi, ctx)

        logger.log(0, "wizard", "complete", plan.title)
        statusText = undefined
        phase = { kind: "done", plan }
        refresh()
      } catch (e) {
        logger.log(0, "wizard", "fatal", e instanceof Error ? e.stack ?? e.message : String(e))
        phase = { kind: "input" }
        setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`)
        await new Promise((r) => setTimeout(r, 4000))
        safeDone()
      }
    })()

    return component
  })
}
