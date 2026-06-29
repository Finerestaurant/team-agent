import type { ToolDefinition, SessionManager } from "@earendil-works/pi-coding-agent"

export type TeamNode = { name: string; label: string; children: TeamNode[] }

export type AgentDef = {
  name: string
  mode: "primary" | "subagent"
  description: string
  prompt?: string
  domainTools?: string[]
  builtins?: string[]
}

export type Cartridge = {
  team: TeamNode
  agents: AgentDef[]
  tools: Record<string, ToolDefinition<any, any>>
  rootAgent: string
  title?: string
  sessionManager?: (agentName: string) => SessionManager
  debugChildren?: Partial<Record<string, string[]>>
  task?: {
    description?: string
    promptSnippet?: string
    promptGuidelines?: string[]
  }
  awaitTask?: {
    description?: string
  }
}
