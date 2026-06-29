# @finerestaurant/team-agent

Multi-agent team orchestration for [pi](https://pi.dev). Plug in a cartridge, describe what you need,
and a team of specialized agents handles it — each with bounded context, working in parallel.

```sh
pi install npm:@finerestaurant/team-agent
```

---

## Why teams?

MCPs are proliferating. The ecosystem has tools for almost everything — Blender, databases, APIs,
file systems, external services. But most people use them one at a time, in a single agent session,
which breaks down fast:

- **Context overload** — one agent juggling everything loses track of what it's doing
- **No specialization** — the same session that searches the web is also writing code and reviewing it
- **No parallelism** — sequential steps when independent work could run concurrently

team-agent addresses this by splitting work across a team. Each agent runs in its own session with
a focused role and a bounded context window. The root agent delegates; sub-agents execute. Context
stays manageable because each agent only sees what it needs to.

MCPs become genuinely useful at scale when there's a team structure behind them.

---

## How it works

```
pi (the console)
└── team-agent (the engine)       ← you install this
    └── your cartridge (the team) ← you pick this
        ├── agents + prompts
        └── domain tools
```

Once installed, run `/cartridge-manager` to pick or create a team. The `task` tool is registered
with pi — just describe what you want done and the team handles the rest.

---

## What you get

**Team panel** — live org chart in the pi sidebar. Agents show idle / active / waiting / done state.

```
  my-team
  ├── ⠹ manager          ← running
  │   ├── ○ researcher   ← waiting (delegated to child)
  │   └── □ writer       ← idle
  └── ✓ reviewer         ← done
```

**`task` tool** — pi delegates to your root agent with full context.

**`await_task` tool** — sub-agents spawn children and block until they complete.

**Pause / resume** — `Ctrl+/` pauses the running task mid-flight. Resume by sending a message.

**Cartridge wizard** — `/cartridge-manager` → `Create new cartridge…` walks you through designing
a team interactively. The wizard generates all boilerplate; you fill in the domain tool implementations.

---

## Usage

After installing a cartridge, just talk to pi normally:

```
> Review this PR and create a summary with action items

  [team panel updates live as agents work]

  ✓ Done — summary saved to review.md
```

No slash commands required. The team activates automatically when pi receives a task.

---

## Building a cartridge

A cartridge is a folder of TypeScript files — no build step, no separate package needed.

```
my-cartridge/
  src/
    agents/
      manager.ts    ← AgentDef with prompt
      worker.ts
      index.ts      ← export const agents = [manager, worker]
    tools/
      search.ts     ← defineTool(...)
      index.ts      ← export const toolMap = { search }
    cartridge.ts    ← assemble Cartridge object
    index.ts        ← export default createExtension(cartridge)
```

**Agent:**
```typescript
import type { AgentDef } from "@finerestaurant/team-agent"

export const manager: AgentDef = {
  name: "manager",
  mode: "primary",
  description: "Breaks down tasks and delegates to workers",
  prompt: `You are a manager. Delegate subtasks using await_task.`,
  domainTools: ["search"],
}
```

**Tool:**
```typescript
import { defineTool } from "@finerestaurant/team-agent"
import { Type } from "typebox"

export const search = defineTool({
  name: "search",
  description: "Search the codebase",
  parameters: Type.Object({ query: Type.String() }),
  execute: async (_id, { query }) => {
    // ...
    return { content: [{ type: "text", text: results }], details: {} }
  },
})
```

**Cartridge:**
```typescript
import type { Cartridge } from "@finerestaurant/team-agent"
import { createExtension } from "@finerestaurant/team-agent"
import { agents } from "./agents/index.ts"
import { toolMap } from "./tools/index.ts"

const cartridge: Cartridge = {
  title: "my-team",
  team: { name: "manager", label: "manager", children: [
    { name: "worker", label: "worker", children: [] }
  ]},
  agents,
  tools: toolMap,
  rootAgent: "manager",
}

export default createExtension(cartridge)
```

To create a cartridge interactively, run `/cartridge-manager` → `Create new cartridge…`

---

## Cartridge API

```typescript
type Cartridge = {
  team: TeamNode                        // org chart
  agents: AgentDef[]                    // agent definitions
  tools: Record<string, ToolDefinition> // domain tools
  rootAgent: string                     // entry point (receives task tool)
  title?: string                        // panel header
  sessionManager?: (name: string) => SessionManager
  task?: {
    description?: string
    promptSnippet?: string
    promptGuidelines?: string[]
  }
}

type AgentDef = {
  name: string
  mode: "primary" | "subagent"
  description: string
  prompt?: string
  domainTools?: string[]   // which tools this agent can use
  builtins?: string[]      // pi built-in tools to allow (e.g. "read_file")
}
```

---

## Requirements

- [pi](https://pi.dev) `>=0.79.9`
- Bun or Node.js 20+

## License

MIT
