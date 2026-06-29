# team-agent

## What this is

`@finerestaurant/team-agent` — multi-agent team orchestration framework for [pi](https://pi.dev).
Provides the engine; cartridges provide the domain logic.

## Architecture

```
src/entry.ts              — pi extension entry point; loads active cartridge from cartridge/
src/extension.ts          — createExtension(cartridge) factory; all cartridges call this
src/types.ts              — Cartridge, TeamNode, AgentDef interfaces
src/index.ts              — public API re-exports (createExtension, types, defineTool, SessionManager)
src/core/task.ts          — async sub-agent runner (spawn, wait, notify)
src/core/pause.ts         — pause/resume controller
src/core/logger.ts        — file logger (~/.team-agent/logs/agents.log)
src/ui/event-bus.ts       — typed event bus (agent:start/end/waiting/resumed, tool:start/end)
src/ui/panel.ts           — team tree UI widget for pi sidebar
src/commands/cartridge-manager.ts  — /cartridge-manager command (install, activate, remove)
src/commands/cartridge-creator.ts  — cartridge creation wizard (interactive TUI + LLM planner)
src/commands/panel-bg.ts           — panel background color command
src/settings.ts           — settings helpers
cartridge/                — slot where cartridges are installed (gitignored)
cartridge/.active         — name of the currently active cartridge
```

## Key concepts

- **Cartridge**: `AgentDef[]` + `TeamNode` tree + tool map + root agent name
- **`createExtension(cartridge)`**: wires up pi tools, panel, event handlers — returns a pi extension function
- **`task` tool**: registered with pi; delegates to the root agent
- **`await_task` tool**: sub-agents use this to spawn children and block until done
- **`check_task` tool**: inspect live status of a running sub-agent
- **`SessionTracker`**: tracks pending child count per agent; emits `agent:waiting` when parent is blocked, `agent:resumed` when a child completes
- **`/cartridge-manager`**: command to install (GitHub URL / local path), activate, update, or remove cartridges; also opens the creation wizard

## Cartridge interface

```typescript
type Cartridge = {
  team: TeamNode                        // org chart for the panel
  agents: AgentDef[]                    // agent definitions
  tools: Record<string, ToolDefinition> // domain tools for sub-agents
  rootAgent: string                     // gets the task tool
  title?: string                        // panel header (default: "team")
  sessionManager?: (name: string) => SessionManager
  debugChildren?: Partial<Record<string, string[]>>  // for debug dry-runs
  task?: { description?: string; promptSnippet?: string; promptGuidelines?: string[] }
  awaitTask?: { description?: string }
}

type AgentDef = {
  name: string
  mode: "primary" | "subagent"
  description: string
  prompt?: string
  domainTools?: string[]   // tool names this agent can use
  builtins?: string[]      // pi built-in tool names to allow
}
```

## Panel states

| State | Icon | Color |
|-------|------|-------|
| Idle | `□` | dim |
| Active | `⠹` (spinner) | accent |
| Waiting (delegated to child) | `○` | warning |
| Done | `✓` | success |

Waiting means the agent's LLM turn ended while `pendingCount > 0`. It resumes only when a child completes (`notifyDone` → `parentTracker.prompt("[task_complete]...")`).

## Cartridge wizard (cartridge-creator.ts)

The wizard runs an LLM planner session with four tools: `ask_user`, `add_agent`, `add_tool`, `finish`.
The planner calls these tools to build a `CartridgePlan`, then `generateCode()` writes all TypeScript
files deterministically (no LLM for codegen). A `SETUP.md` is generated listing unimplemented tool
bodies for the user to fill in.

Key functions:
- `runPlanner()` — creates a pi agent session with planner tools, prompts with user description
- `refinePlan()` — re-prompts the same session with `buildRefinePrompt()` (serializes current plan)
- `generateCode()` — deterministic codegen: `genAgentTs`, `genToolTs`, `genCartridgeTs`, etc.
- `toVarName()` — `toCamelCase` + appends `Agent` suffix if result is a JS reserved keyword
- `installAndActivate()` — symlinks to `cartridge/`, runs `bun install`, activates

## Cartridge loading

`entry.ts` reads `cartridge/.active`, does a dynamic `import(cartridge/NAME/src/index.ts)`.
If the import fails (parse error, type error), the extension loads without a team — pi has no `task`
tool and operates in degraded mode.

## Code generation reserved word guard

Agent/tool names that collide with JS reserved words (e.g. `debugger`, `class`, `delete`) are
handled by `toVarName()` in `cartridge-creator.ts`. The variable name gets an `Agent` suffix:
`debugger` → `debuggerAgent`. The `name` field in the `AgentDef` keeps the original string.

## Environment

- Runtime: Bun
- Language: TypeScript (ESNext, verbatimModuleSyntax)
- Log file override: `TEAM_AGENT_LOG_FILE`
- Never write to stdout/stderr (breaks pi TUI rendering)
- typecheck: `bun run typecheck` (runs `tsc --noEmit`)
