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
src/core/task.ts          — async sub-agent runner (spawn, wait, notify); registers task/await_task/check_task/resume_child/cancel_child tools
src/core/session.ts       — Session (per-node lifecycle: active/waiting/paused/done/error/cancelled) + SessionRegistry (tree-shaped storage over the cartridge's TeamNode)
src/core/logger.ts        — file logger (~/.team-agent/logs/agents.log)
src/ui/event-bus.ts       — typed event bus (agent:start/end/waiting/resumed/paused/unpaused, tool:start/end)
src/ui/panel.ts           — team tree UI widget for pi sidebar
src/commands/cartridge-manager/index.ts    — /cartridge-manager command (install, activate, remove)
src/commands/cartridge-manager/creator.ts  — cartridge creation wizard (interactive TUI + LLM planner)
src/commands/cartridge-manager/codegen.ts  — deterministic codegen for wizard-generated cartridges
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
- **`check_task` tool**: inspect live status of a running sub-agent (`active`/`waiting`/`paused`/`done`/`error`/`cancelled`)
- **`resume_child`/`cancel_child` tools**: auto-injected to PI and every delegation-capable agent (same rule as `await_task`/`check_task`) — caller identity resolves via `trackerStore.getStore()`. `resume_child` is 1-hop only (no auto-cascade to grandchildren — the just-resumed agent must call it again itself to relay further). `cancel_child` is 1-hop entry but cascades below unconditionally.
- **`Session`**: per-node lifecycle wrapper; tracks pending child count per agent, emits `agent:waiting`/`agent:resumed` when a child blocks/completes, `agent:paused`/`agent:unpaused` on pause/resume
- **`SessionRegistry`**: singleton holding all live `Session`s keyed by agent name, reusing the cartridge's `TeamNode` for tree shape (no separate tree structure). Owns `pauseSubtree()` (the one action that cascades the whole tree — ctrl+/-triggered, non-destructive) and `resumeChild()`/`cancelChild()` (1-hop, validated against `TeamNode`)
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
| Paused | `⏸` | warning |
| Cancelled | `⊘` | dim |
| Error | `☒` | error |
| Done | `✓` | success |

Waiting means the agent's LLM turn ended while `pendingCount > 0`. It resumes only when a child completes (`Session.markDone/markError` → `reportToParent` → `parent.promptFn("[task_complete]...")`).

Pause (`ctrl+/`) freezes the whole tree at once via `SessionRegistry.pauseSubtree()` — non-destructive, sessions/timers keep running in the background, only event relay and parent notification are suppressed. A child spawned by an already-paused parent is paused at birth too. Resuming is 1-hop only (`resume_child`) and does not cascade — each resumed agent must call `resume_child` itself to relay further down. `Session.resume()` always gives the agent a real turn, even with no instruction, so it has a chance to notice and relay to its own paused children.

## Cartridge wizard (cartridge-manager/creator.ts)

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
handled by `toVarName()` in `cartridge-manager/creator.ts`. The variable name gets an `Agent` suffix:
`debugger` → `debuggerAgent`. The `name` field in the `AgentDef` keeps the original string.

## Environment

- Runtime: Bun
- Language: TypeScript (ESNext, verbatimModuleSyntax)
- Log file override: `TEAM_AGENT_LOG_FILE`
- Never write to stdout/stderr (breaks pi TUI rendering)
- typecheck: `bun run typecheck` (runs `tsc --noEmit`)
