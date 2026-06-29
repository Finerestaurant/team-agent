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
import * as child_process from "node:child_process"
import type { AgentDef, TeamNode } from "../types.ts"
import * as logger from "../core/logger.ts"
import { emit } from "../ui/event-bus.ts"
import * as panel from "../ui/panel.ts"

const CARTRIDGE_DIR = pathLib.join(
  pathLib.dirname(new URL(import.meta.url).pathname),
  "../..",
  "cartridge",
)

// ─── Types ────────────────────────────────────────────────────────────────────

type ToolParam = {
  name: string
  type: string
  description: string
  optional?: boolean
}

type ToolDef = {
  name: string
  description: string
  parameters: ToolParam[]
  implementation: string
}

type CartridgePlan = {
  title: string
  description: string
  team: TeamNode
  agents: AgentDef[]
  tools: ToolDef[]
}

type ConvEntry = { type: "q" | "a"; text: string }

type WizardPhase =
  | { kind: "input" }
  | { kind: "thinking" }
  | { kind: "confirm"; plan: CartridgePlan }
  | { kind: "done"; plan: CartridgePlan }

// ─── Prompts ──────────────────────────────────────────────────────────────────

const PLANNER_SYSTEM = `You are a team-agent cartridge architect.

Important: Do not describe the team structure in text or markdown. Deliver results only through tool calls.

Steps:
1. Use ask_user tool for clarification if needed (optional)
2. Define domain tools with add_tool (skip if none needed)
3. Add agents with add_agent — always add parent before children, parent:null means root
4. Call finish — the design is not saved without this

add_agent rules:
- name: snake_case
- parent: name of an already-added agent, null for root
- tools: only names registered via add_tool
- mode: "primary" for root only, "subagent" for all others

Domain tool design principles:
- Domain tools are for external I/O only (file read/write, HTTP API, database, external process calls)
- Do not create tools for cognitive tasks the LLM can do itself (translation, review, summarization, analysis) — agents handle those
- Describe input parameters precisely in add_tool's parameters field, and describe the implementation method concretely in implementation (e.g. "store terms and translations in a JSON file, handle add/lookup/list based on action")

No text descriptions. Call tools immediately.`

// ─── Code generation helpers ─────────────────────────────────────────────────

function toCamelCase(s: string): string {
  return s.replace(/[-_]([a-z])/g, (_, c: string) => c.toUpperCase())
}

const JS_RESERVED = new Set([
  "break","case","catch","class","const","continue","debugger","default",
  "delete","do","else","export","extends","false","finally","for","function",
  "if","import","in","instanceof","let","new","null","return","static",
  "super","switch","this","throw","true","try","typeof","var","void",
  "while","with","yield","enum","await","implements","interface","package",
  "private","protected","public",
])

function toVarName(s: string): string {
  const name = toCamelCase(s)
  return JS_RESERVED.has(name) ? `${name}Agent` : name
}

function toTitleCase(kebab: string): string {
  return kebab.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
}

function typeboxType(t: string): string {
  if (t === "string") return "Type.String()"
  if (t === "number") return "Type.Number()"
  if (t === "boolean") return "Type.Boolean()"
  if (t === "string[]") return "Type.Array(Type.String())"
  if (t.includes("|")) {
    const members = t.split("|").map((s) => `Type.Literal(${JSON.stringify(s.trim().replace(/^['"]|['"]$/g, ""))})`)
    return `Type.Union([${members.join(", ")}])`
  }
  return "Type.String()"
}

function teamNodeTs(node: TeamNode, depth: number): string {
  const pad = "  ".repeat(depth)
  const childPad = "  ".repeat(depth + 1)
  if (node.children.length === 0) {
    return `{ name: ${JSON.stringify(node.name)}, label: ${JSON.stringify(node.label)}, children: [] }`
  }
  const children = node.children.map((c) => `${childPad}${teamNodeTs(c, depth + 1)}`).join(",\n")
  return `{ name: ${JSON.stringify(node.name)}, label: ${JSON.stringify(node.label)}, children: [\n${children},\n${pad}] }`
}

function genIndexTs(): string {
  return `import { createExtension } from "team-agent"
import { cartridge } from "./cartridge"

export default createExtension(cartridge)
`
}

function genCartridgeTs(plan: CartridgePlan): string {
  const rootAgent = plan.agents.find((a) => a.mode === "primary")?.name ?? plan.agents[0]?.name ?? ""
  return `import type { Cartridge, TeamNode } from "team-agent"
import { agents } from "./agents"
import { toolMap } from "./tools"

const team: TeamNode = ${teamNodeTs(plan.team, 0)}

export const cartridge: Cartridge = {
  title: ${JSON.stringify(plan.title)},
  rootAgent: ${JSON.stringify(rootAgent)},
  team,
  agents,
  tools: toolMap,
}
`
}

function genAgentTs(agent: AgentDef): string {
  const varName = toVarName(agent.name)
  const prompt = (agent.prompt ?? "").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")
  const domainTools = (agent.domainTools ?? []).map((t) => JSON.stringify(t)).join(", ")
  return `import type { AgentDef } from "team-agent"

export const ${varName}: AgentDef = {
  name: ${JSON.stringify(agent.name)},
  mode: ${JSON.stringify(agent.mode)},
  description: ${JSON.stringify(agent.description)},
  prompt: \`${prompt}\`,
  domainTools: [${domainTools}],
}
`
}

function genAgentsIndexTs(agents: AgentDef[]): string {
  const imports = agents.map((a) => `import { ${toVarName(a.name)} } from "./${a.name}"`).join("\n")
  const list = agents.map((a) => toVarName(a.name)).join(", ")
  return `${imports}\n\nexport const agents = [${list}]\n`
}

function genToolTs(tool: ToolDef): string {
  const varName = toVarName(tool.name)
  const paramFields = tool.parameters.map((p) => {
    const tb = p.optional ? `Type.Optional(${typeboxType(p.type)})` : typeboxType(p.type)
    return `    ${p.name}: ${tb},`
  }).join("\n")
  const destructure = tool.parameters.length > 0
    ? `{ ${tool.parameters.map((p) => p.name).join(", ")} }`
    : "_params"
  return `import { defineTool } from "team-agent"
import { Type } from "typebox"

export const ${varName} = defineTool({
  name: ${JSON.stringify(tool.name)},
  label: ${JSON.stringify(toTitleCase(tool.name))},
  description: ${JSON.stringify(tool.description)},
  parameters: Type.Object({
${paramFields || "    // no parameters"}
  }),
  execute: async (_id, ${destructure}) => {
    // TODO: ${tool.implementation}
    throw new Error(${JSON.stringify(`Not implemented: ${tool.name}`)})
  },
})
`
}

function genToolsIndexTs(tools: ToolDef[]): string {
  if (tools.length === 0) return `export const toolMap = {} as const\n`
  const imports = tools.map((t) => `import { ${toVarName(t.name)} } from "./${t.name}"`).join("\n")
  const entries = tools.map((t) => `  ${JSON.stringify(t.name)}: ${toVarName(t.name)},`).join("\n")
  return `${imports}\n\nexport const toolMap = {\n${entries}\n} as const\n`
}

function genSetupMd(plan: CartridgePlan, destDir: string): string {
  const agentLines = plan.agents.map((a) => `- **${a.name}** (${a.mode}): ${a.description}`).join("\n")

  const toolSections = plan.tools.length === 0
    ? "(no domain tools)\n"
    : plan.tools.map((t) => {
        const params = t.parameters.map((p) =>
          `  - \`${p.name}\` (${p.type}${p.optional ? ", optional" : ""}): ${p.description}`
        ).join("\n")
        return `### \`${t.name}\`
**Implementation**: ${t.implementation}
${params ? `**Parameters**:\n${params}\n` : ""}File: \`src/tools/${t.name}.ts\``
      }).join("\n\n")

  return `# ${plan.title} — Setup Guide

Generated by the team-agent cartridge wizard.
Agent structure, tool interfaces, and cartridge config have been generated automatically.
Complete the items below to make the cartridge functional.

## Team structure

${agentLines}

## Unimplemented tools (execute body required)

${toolSections}

## Next steps

### 1. Simple tools — implement directly
Open each \`src/tools/<name>.ts\` and replace the TODO in the \`execute\` body with real code.

### 2. Use Claude Code
\`\`\`
claude ${destDir}
\`\`\`
Then say: "Read SETUP.md and implement the unimplemented tools"

### 3. External integrations
Tools that require domain-specific APIs or protocols need additional work:

- **MCP server**: control an external program → build an MCP server for it first
  - e.g. Logic Pro → implement a Logic Pro MCP server, then call it from the tool
  - e.g. KiCad → implement KiCad IPC-API integration
- **HTTP API**: call an external service → set up API keys and auth
- **DB/socket**: manage connection info via environment variables or config file

Once the external integration is ready, call it from the \`execute\` body.

---
*Generated by team-agent cartridge wizard*
`
}

// ─── Planner state & tools ────────────────────────────────────────────────────

type PlannerHandle = {
  session: any
  nodeId: string
  reset: () => void
  getPlan: () => CartridgePlan | undefined
  setOnTree: (cb: (tree: TeamNode | undefined) => void) => void
}

function makePlannerState(
  askUser: (q: string) => Promise<string | null>,
  onStatus: (text: string) => void,
  initialOnTree: (tree: TeamNode | undefined) => void,
) {
  let onTree = initialOnTree
  function setOnTree(cb: (tree: TeamNode | undefined) => void) { onTree = cb }
  const agentDefs: AgentDef[] = []
  const toolDefs: ToolDef[] = []
  const nodeMap = new Map<string, TeamNode>()
  let rootNode: TeamNode | undefined
  let planTitle: string | undefined
  let planDescription: string | undefined
  let cancelled = false

  function reset() {
    agentDefs.length = 0
    toolDefs.length = 0
    nodeMap.clear()
    rootNode = undefined
    planTitle = undefined
    planDescription = undefined
    onTree(undefined)
  }

  function getPlan(): CartridgePlan | undefined {
    if (!rootNode || !planTitle) return undefined
    return { title: planTitle, description: planDescription ?? "", team: rootNode, agents: [...agentDefs], tools: [...toolDefs] }
  }

  const AddAgentParams = Type.Object({
    name: Type.String({ description: "snake_case identifier" }),
    label: Type.String({ description: "display name" }),
    parent: Type.Union([Type.String(), Type.Null()], { description: "parent agent name, null for root" }),
    mode: Type.Union([Type.Literal("primary"), Type.Literal("subagent")]),
    description: Type.String(),
    prompt: Type.String({ description: "agent system prompt" }),
    tools: Type.Array(Type.String(), { description: "list of domain tool names this agent can use" }),
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
  const FinishParams = Type.Object({
    title: Type.String({ description: "kebab-case cartridge name" }),
    description: Type.String({ description: "one-sentence description" }),
  })
  const AskParams = Type.Object({ question: Type.String() })

  const tools = [
    defineTool<typeof AskParams, {}>({
      name: "ask_user", label: "Ask User",
      description: "ask the user a clarification question",
      parameters: AskParams,
      execute: async (_id, { question }) => {
        logger.log(1, "wizard", "ask_user:question", question)
        const answer = await askUser(question)
        logger.log(1, "wizard", "ask_user:answer", answer ?? "(cancelled)")
        if (answer === null) { cancelled = true; throw new Error("WIZARD_CANCELLED") }
        return { content: [{ type: "text" as const, text: answer }], details: {} }
      },
    }),
    defineTool<typeof AddAgentParams, {}>({
      name: "add_agent", label: "Add Agent",
      description: "add an agent to the team",
      parameters: AddAgentParams,
      execute: (_id, { name, label, parent, mode, description, prompt, tools: agentTools }) => {
        const node: TeamNode = { name, label, children: [] }
        nodeMap.set(name, node)
        if (!parent) {
          rootNode = node
        } else {
          const p = nodeMap.get(parent)
          if (p) p.children.push(node)
          else logger.log(1, "wizard", "add_agent:parent-not-found", { name, parent })
        }
        agentDefs.push({ name, mode, description, prompt, domainTools: agentTools })
        logger.log(1, "wizard", "add_agent", { name, parent, mode })
        onTree(rootNode)
        return Promise.resolve({ content: [{ type: "text" as const, text: `✓ ${name}` }], details: {} })
      },
    }),
    defineTool<typeof AddToolParams, {}>({
      name: "add_tool", label: "Add Tool",
      description: "define a domain tool",
      parameters: AddToolParams,
      execute: (_id, { name, description, parameters, implementation }) => {
        toolDefs.push({ name, description, parameters: parameters ?? [], implementation: implementation ?? "" })
        logger.log(1, "wizard", "add_tool", { name, params: parameters?.length ?? 0 })
        return Promise.resolve({ content: [{ type: "text" as const, text: `✓ ${name}` }], details: {} })
      },
    }),
    defineTool<typeof FinishParams, {}>({
      name: "finish", label: "Finish",
      description: "finalize the team design",
      parameters: FinishParams,
      execute: (_id, { title, description }) => {
        planTitle = title
        planDescription = description
        logger.log(0, "wizard", "finish", { title, agents: agentDefs.length, tools: toolDefs.length })
        return Promise.resolve({ content: [{ type: "text" as const, text: "done" }], details: {} })
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
}

async function installAndActivate(
  plan: CartridgePlan,
  destDir: string,
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child_process.exec("bun install", { cwd: destDir }, (err) => (err ? reject(err) : resolve()))
  })
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
    tools: ["ask_user", "add_agent", "add_tool", "finish"],
    noTools: "builtin",
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
    authStorage: ctx.modelRegistry.authStorage,
    modelRegistry: ctx.modelRegistry,
  })

  session.subscribe((event: any) => {
    if (event.type === "message_update" && event.message?.role === "assistant") {
      const text = event.message.content
        ?.filter((b: any) => b.type === "text")
        .map((b: any) => b.text as string)
        .join("")
        .replace(/\s+/g, " ")
        .trim()
      if (text) logger.log(1, "wizard", "planner:thinking", text.slice(0, 200))
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

function buildRefinePrompt(currentPlan: CartridgePlan, instructions: string): string {
  const agentLines = currentPlan.agents.map((a) =>
    `  - ${a.name} (${a.mode}): tools=[${(a.domainTools ?? []).join(", ")}]`
  ).join("\n")
  const toolLines = currentPlan.tools.map((t) =>
    `  - ${t.name}: ${t.description}`
  ).join("\n")
  return `Current team configuration:
title: "${currentPlan.title}"
agents:
${agentLines || "  (none)"}
tools:
${toolLines || "  (none)"}

Modification request: ${instructions}

Apply the modification request to the current team configuration.
Preserve existing agent/tool names as much as possible. Include unchanged items as well and rebuild the full configuration in add_tool → add_agent → finish order.`
}

async function refinePlan(
  handle: PlannerHandle,
  currentPlan: CartridgePlan,
  instructions: string,
  askUser: (question: string) => Promise<string | null>,
  onStatus: (text: string) => void,
  onTree: (tree: TeamNode | undefined) => void,
): Promise<CartridgePlan | "cancelled" | undefined> {
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

// ─── Code generation ──────────────────────────────────────────────────────────

function generateCode(
  plan: CartridgePlan,
  destDir: string,
  onStatus: (text: string) => void,
  onAgentBuilt: (name: string) => void,
): void {
  let fileCount = 0
  function write(relPath: string, content: string): void {
    const full = pathLib.join(destDir, relPath)
    fs.mkdirSync(pathLib.dirname(full), { recursive: true })
    fs.writeFileSync(full, content, "utf-8")
    fileCount++
    logger.log(1, "wizard", "codegen:write", relPath)
    onStatus(`Writing files... (${fileCount})`)
  }

  write("src/index.ts", genIndexTs())
  write("src/cartridge.ts", genCartridgeTs(plan))

  for (const agent of plan.agents) {
    write(`src/agents/${agent.name}.ts`, genAgentTs(agent))
    onAgentBuilt(agent.name)
  }
  write("src/agents/index.ts", genAgentsIndexTs(plan.agents))

  for (const tool of plan.tools) {
    write(`src/tools/${tool.name}.ts`, genToolTs(tool))
  }
  write("src/tools/index.ts", genToolsIndexTs(plan.tools))

  write("SETUP.md", genSetupMd(plan, destDir))

  logger.log(0, "wizard", "codegen:done", { files: fileCount, agents: plan.agents.length, tools: plan.tools.length })
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
    let lastPlan: CartridgePlan | undefined
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

    function waitForConfirm(plan: CartridgePlan): Promise<"create" | "chat" | "cancel"> {
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
          if (lastPlan) {
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
          renderPlanTree(plan.team, theme, "", true, true, treeLines, undefined, agentMap)
          for (const l of treeLines) lines.push(` ${l}`)
          lines.push("")
          lines.push(` ${theme.fg("dim", `${plan.agents.length} agents  ${plan.tools.length} tools`)}`)
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
          renderPlanTree(plan.team, theme, "", true, true, treeLines, builtAgents)
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

        generateCode(plan, destDir, (text) => setStatus(text), (name) => {
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
