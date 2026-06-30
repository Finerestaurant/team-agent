import * as fs from "node:fs"
import * as pathLib from "node:path"
import type { AgentDef, TeamNode } from "../../types.ts"

// ─── Types ────────────────────────────────────────────────────────────────────

export type ToolParam = {
  name: string
  type: string
  description: string
  optional?: boolean
}

export type ToolDef = {
  name: string
  description: string
  parameters: ToolParam[]
  implementation: string
}

// ─── Private helpers ──────────────────────────────────────────────────────────

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

export function toVarName(s: string): string {
  const name = toCamelCase(s)
  return JS_RESERVED.has(name) ? `${name}Agent` : name
}

export function toTitleCase(kebab: string): string {
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

// ─── Code generators (used by CartridgeDraft.saveAsCode) ─────────────────────

function genIndexTs(): string {
  return `import { createExtension } from "team-agent"
import { cartridge } from "./cartridge"

export default createExtension(cartridge)
`
}

function genCartridgeTs(draft: CartridgeDraft): string {
  const hasTask = !!(draft.task.description || draft.task.promptSnippet || draft.task.promptGuidelines.length)
  const taskField = hasTask
    ? `\n  task: {\n    description: ${JSON.stringify(draft.task.description)},\n    promptSnippet: ${JSON.stringify(draft.task.promptSnippet)},\n    promptGuidelines: ${JSON.stringify(draft.task.promptGuidelines)},\n  },`
    : ""
  return `import type { Cartridge, TeamNode } from "team-agent"
import { agents } from "./agents"
import { toolMap } from "./tools"

const team: TeamNode = ${teamNodeTs(draft.team!, 0)}

export const cartridge: Cartridge = {
  title: ${JSON.stringify(draft.title)},
  rootAgent: ${JSON.stringify(draft.rootAgent)},
  team,
  agents,
  tools: toolMap,${taskField}
}
`
}

function genAgentTs(agent: AgentDef): string {
  const varName = toVarName(agent.name)
  const prompt = (agent.prompt ?? "").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")
  const domainTools = (agent.domainTools ?? []).map((t) => JSON.stringify(t)).join(", ")
  const builtins = (agent.builtins ?? []).map((t) => JSON.stringify(t)).join(", ")
  const builtinsField = builtins ? `\n  builtins: [${builtins}],` : ""
  return `import type { AgentDef } from "team-agent"

export const ${varName}: AgentDef = {
  name: ${JSON.stringify(agent.name)},
  mode: ${JSON.stringify(agent.mode)},
  description: ${JSON.stringify(agent.description)},
  prompt: \`${prompt}\`,
  domainTools: [${domainTools}],${builtinsField}
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

function genSetupMd(draft: CartridgeDraft, destDir: string): string {
  const agentLines = draft.agents.map((a) => `- **${a.name}** (${a.mode}): ${a.description}`).join("\n")
  const toolSections = draft.tools.length === 0
    ? "(no domain tools)\n"
    : draft.tools.map((t) => {
        const params = t.parameters.map((p) =>
          `  - \`${p.name}\` (${p.type}${p.optional ? ", optional" : ""}): ${p.description}`
        ).join("\n")
        return `### \`${t.name}\`\n**Implementation**: ${t.implementation}\n${params ? `**Parameters**:\n${params}\n` : ""}File: \`src/tools/${t.name}.ts\``
      }).join("\n\n")

  return `# ${draft.title} — Setup Guide

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
- **HTTP API**: call an external service → set up API keys and auth
- **DB/socket**: manage connection info via environment variables or config file

---
*Generated by team-agent cartridge wizard*
`
}

// ─── CartridgeDraft ───────────────────────────────────────────────────────────

export class CartridgeDraft {
  title = ""
  description = ""
  team: TeamNode | undefined
  agents: AgentDef[] = []
  tools: ToolDef[] = []
  task = {
    description: "",
    promptSnippet: "",
    promptGuidelines: [] as string[],
  }

  private nodeMap = new Map<string, TeamNode>()

  get rootAgent(): string {
    return this.agents.find((a) => a.mode === "primary")?.name ?? this.agents[0]?.name ?? ""
  }

  addAgent(params: {
    name: string
    label: string
    parent: string | null
    mode: "primary" | "subagent"
    description: string
    prompt: string
    domainTools: string[]
    builtins?: string[]
  }): string | null {
    const node: TeamNode = { name: params.name, label: params.label, children: [] }
    this.nodeMap.set(params.name, node)
    if (!params.parent) {
      this.team = node
    } else {
      const p = this.nodeMap.get(params.parent)
      if (!p) return `parent "${params.parent}" not found`
      p.children.push(node)
    }
    this.agents.push({
      name: params.name,
      mode: params.mode,
      description: params.description,
      prompt: params.prompt,
      domainTools: params.domainTools,
      ...(params.builtins?.length ? { builtins: params.builtins } : {}),
    })
    return null
  }

  addTool(tool: ToolDef): void {
    this.tools.push(tool)
  }

  reset(): void {
    this.title = ""
    this.description = ""
    this.team = undefined
    this.agents = []
    this.tools = []
    this.task = { description: "", promptSnippet: "", promptGuidelines: [] }
    this.nodeMap = new Map()
  }

  isReady(): boolean {
    return !!this.title && !!this.team && this.agents.length > 0
  }

  async saveAsCode(
    destDir: string,
    onStatus: (text: string) => void,
    onAgentBuilt: (name: string) => void,
  ): Promise<void> {
    let fileCount = 0
    const write = (relPath: string, content: string) => {
      const full = pathLib.join(destDir, relPath)
      fs.mkdirSync(pathLib.dirname(full), { recursive: true })
      fs.writeFileSync(full, content, "utf-8")
      fileCount++
      onStatus(`Writing files... (${fileCount})`)
    }
    const tick = () => new Promise<void>((r) => setTimeout(r, 20))

    write("src/index.ts", genIndexTs())
    write("src/cartridge.ts", genCartridgeTs(this))

    for (const agent of this.agents) {
      write(`src/agents/${agent.name}.ts`, genAgentTs(agent))
      onAgentBuilt(agent.name)
      await tick()
    }
    write("src/agents/index.ts", genAgentsIndexTs(this.agents))

    for (const tool of this.tools) {
      write(`src/tools/${tool.name}.ts`, genToolTs(tool))
    }
    write("src/tools/index.ts", genToolsIndexTs(this.tools))

    write("SETUP.md", genSetupMd(this, destDir))
  }
}
