import type { ToolDefinition, SessionManager } from "@earendil-works/pi-coding-agent"

export type TeamNode = { name: string; label: string; children: TeamNode[] }

export type ScriptStep =
  | { type: "delay"; ms: number }
  | { type: "activity"; text: string }
  | { type: "tool"; name: string; ms: number }
  | { type: "spawn"; child: string }
  | { type: "spawn_parallel"; children: string[] }
  | { type: "error"; message: string }

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
  agentScripts?: Partial<Record<string, ScriptStep[]>>
  task?: {
    description?: string
    promptSnippet?: string
    promptGuidelines?: string[]
  }
  awaitTask?: {
    description?: string
  }
}
