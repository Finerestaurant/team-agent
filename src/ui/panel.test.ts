import { describe, it, expect, beforeEach } from "bun:test"
import { visibleWidth } from "@earendil-works/pi-tui"
import * as panel from "./panel.ts"
import { emit } from "./event-bus.ts"
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent"
import type { TeamNode } from "../types.ts"

// ─── Themes ──────────────────────────────────────────────────────────────────

// Strips all ANSI — readable plain text
const plainTheme = {
  fg: (_: ThemeColor, text: string) => text,
  bg: (_: any, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  inverse: (text: string) => text,
  strikethrough: (text: string) => text,
  getFgAnsi: () => "",
  getBgAnsi: () => "",
  getColorMode: () => "truecolor" as const,
  getThinkingBorderColor: () => (s: string) => s,
  getBashModeBorderColor: () => (s: string) => s,
} as unknown as Theme

// Tags fg colors so connector/label colors can be asserted
const taggedTheme = {
  ...plainTheme,
  fg: (color: ThemeColor, text: string) => `[${color}]${text}[/${color}]`,
} as unknown as Theme

// ─── Tree fixtures ────────────────────────────────────────────────────────────

const TREE: TeamNode = {
  name: "root",
  label: "root",
  children: [
    {
      name: "child-a",
      label: "child-a",
      children: [
        { name: "leaf-a1", label: "leaf-a1", children: [] },
        { name: "leaf-a2", label: "leaf-a2", children: [] },
      ],
    },
    { name: "child-b", label: "child-b", children: [] },
  ],
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SPINNER_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/
// Tree node lines always carry one of these markers; the header badge does not
const MARKER_RE = /[□✓○⏸⊘⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/

function render(theme: Theme = plainTheme) {
  return panel.debugRender(theme)
}

function renderAt(width: number, theme: Theme = plainTheme) {
  return panel.debugRenderAt(theme, width)
}

function joined(theme: Theme = plainTheme) {
  return render(theme).join("\n")
}

// Finds the tree-node line for an agent, skipping the header badge line
function lineFor(agentName: string, theme: Theme = plainTheme) {
  return render(theme).find((l) => l.includes(agentName) && MARKER_RE.test(l)) ?? ""
}

function start(nodeId: string, agentName: string) {
  emit({ type: "agent:start", nodeId, agentName })
}

function end(nodeId: string, agentName: string, status: "done" | "error" | "cancelled" = "done") {
  emit({ type: "agent:end", nodeId, agentName, status })
}

function wait(nodeId: string, agentName: string) {
  emit({ type: "agent:waiting", nodeId, agentName })
}

function resumed(nodeId: string, agentName: string) {
  emit({ type: "agent:resumed", nodeId, agentName })
}

function pause(nodeId: string, agentName: string) {
  emit({ type: "agent:paused", nodeId, agentName })
}

function unpause(nodeId: string, agentName: string) {
  emit({ type: "agent:unpaused", nodeId, agentName })
}

function toolStart(nodeId: string, toolName: string) {
  emit({ type: "tool:start", nodeId, toolName })
}

function toolEnd(nodeId: string, toolName: string) {
  emit({ type: "tool:end", nodeId, toolName, isError: false })
}

function activity(nodeId: string, text: string) {
  emit({ type: "agent:activity", nodeId, text })
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  panel.clear()
  panel.init({ team: TREE, title: "test" })
})

// ─── 1. Agent states ──────────────────────────────────────────────────────────

describe("1. agent states", () => {
  it("1-1: idle — □", () => {
    const line = lineFor("root")
    expect(line).toContain("□")
    expect(line).not.toMatch(SPINNER_RE)
    expect(line).not.toContain("✓")
  })

  it("1-2: active — spinner", () => {
    start("n1", "root")
    const line = lineFor("root")
    expect(line).toMatch(SPINNER_RE)
    expect(line).not.toContain("□")
    expect(line).not.toContain("✓")
  })

  it("1-3: waiting — ○", () => {
    start("n1", "root")
    wait("n1", "root")
    const line = lineFor("root")
    expect(line).toContain("○")
    expect(line).not.toMatch(SPINNER_RE)
  })

  it("1-4: done — ✓", () => {
    start("n1", "root")
    end("n1", "root")
    const line = lineFor("root")
    expect(line).toContain("✓")
    expect(line).not.toMatch(SPINNER_RE)
    expect(line).not.toContain("□")
  })

  it("1-5: paused — ⏸", () => {
    start("n1", "root")
    pause("n1", "root")
    const line = lineFor("root")
    expect(line).toContain("⏸")
    expect(line).not.toMatch(SPINNER_RE)
  })

  it("1-6: re-run — ✓ → spinner → ✓", () => {
    start("n1", "root")
    end("n1", "root")
    expect(lineFor("root")).toContain("✓")

    start("n2", "root")
    expect(lineFor("root")).toMatch(SPINNER_RE)

    end("n2", "root")
    expect(lineFor("root")).toContain("✓")
  })

  it("1-7: cancelled — ⊘", () => {
    start("n1", "root")
    end("n1", "root", "cancelled")
    const line = lineFor("root")
    expect(line).toContain("⊘")
    expect(line).not.toMatch(SPINNER_RE)
    expect(line).not.toContain("✓")
  })

  it("1-8: re-delegation after cancel clears ⊘ — spinner shows again", () => {
    start("n1", "root")
    end("n1", "root", "cancelled")
    expect(lineFor("root")).toContain("⊘")

    start("n2", "root")
    expect(lineFor("root")).toMatch(SPINNER_RE)
    expect(lineFor("root")).not.toContain("⊘")
  })
})

// ─── 2. Connector colors ─────────────────────────────────────────────────────

describe("2. connector colors", () => {
  it("2-1: all idle — dim connectors", () => {
    const out = joined(taggedTheme)
    expect(out).toContain("[dim]├─")
    expect(out).toContain("[dim]└─")
    expect(out).not.toContain("[accent]├─")
    expect(out).not.toContain("[success]├─")
  })

  it("2-2: child active — accent connector on child", () => {
    start("n1", "child-a")
    const out = joined(taggedTheme)
    // child-a's own connector becomes accent
    expect(out).toContain("[accent]├─")
  })

  it("2-3: child done — success connector", () => {
    start("n1", "child-a")
    end("n1", "child-a")
    const out = joined(taggedTheme)
    expect(out).toContain("[success]├─")
    expect(out).not.toContain("[accent]├─")
  })

  it("2-4: mixed siblings — child-a done, child-b idle — different connectors", () => {
    start("n1", "child-a")
    end("n1", "child-a")
    const out = joined(taggedTheme)
    expect(out).toContain("[success]├─") // child-a done
    expect(out).toContain("[dim]└─")     // child-b still idle
  })
})

// ─── 3. Badges / labels ───────────────────────────────────────────────────────

describe("3. badges / labels", () => {
  it("3-1: tool badge shown while active and not waiting", () => {
    start("n1", "root")
    toolStart("n1", "my_tool")
    const line = lineFor("root")
    expect(line).toContain("[my_tool]")
  })

  it("3-2: tool badge cleared after tool:end", () => {
    start("n1", "root")
    toolStart("n1", "my_tool")
    toolEnd("n1", "my_tool")
    const line = lineFor("root")
    expect(line).not.toContain("[my_tool]")
  })

  it("3-3: tool badge hidden while waiting (even if tool ran before)", () => {
    start("n1", "root")
    toolStart("n1", "my_tool")
    wait("n1", "root")
    const line = lineFor("root")
    // waiting state suppresses tool badge display
    expect(line).not.toContain("[my_tool]")
  })

  it("3-4: activity text shown inline while active", () => {
    start("n1", "root")
    activity("n1", "analyzing dependencies")
    const line = lineFor("root")
    expect(line).toContain("analyzing dependencies")
  })

  it("3-5: activity text updates — only latest shown", () => {
    start("n1", "root")
    activity("n1", "first text")
    activity("n1", "second text")
    const line = lineFor("root")
    expect(line).toContain("second text")
    expect(line).not.toContain("first text")
  })

  it("3-6: activity text expanded on separate lines when expanded=true", () => {
    start("n1", "root")
    activity("n1", "detailed activity output")
    const collapsed = panel.debugRender(plainTheme, false).join("\n")
    const expanded = panel.debugRender(plainTheme, true).join("\n")
    // collapsed: activity inline on same line as agent name
    expect(collapsed).toMatch(/root.*detailed activity output/)
    // expanded: activity on its own line(s) below agent name
    const expandedLines = panel.debugRender(plainTheme, true)
    const rootIdx = expandedLines.findIndex((l) => l.includes("root"))
    const activityLine = expandedLines.slice(rootIdx + 1).find((l) => l.includes("detailed activity output"))
    expect(activityLine).toBeDefined()
  })
})

// ─── 4. Header badge ─────────────────────────────────────────────────────────

describe("4. header badge", () => {
  it("4-1: idle — shows title only, no agent name", () => {
    const out = joined()
    expect(out).toContain("test")
    expect(out).not.toContain("root  ")
  })

  it("4-2: active — shows title + agent name + elapsed", () => {
    start("n1", "root")
    const out = joined()
    // header line has title and root agent name
    expect(out).toContain("test")
    expect(out).toContain("root")
    expect(out).toMatch(/\d+s/) // some elapsed time
  })

  it("4-3: elapsed increments over time", async () => {
    start("n1", "root")
    await new Promise((r) => setTimeout(r, 1100))
    const out = joined()
    // at least 1s should have elapsed
    expect(out).toMatch(/[1-9]\d*s/)
  })

  it("4-4: done — header returns to title only", () => {
    start("n1", "root")
    end("n1", "root")
    const lines = render()
    // The badge line (after the top hr and blank line) should be title only
    const badgeLine = lines.find((l) => l.includes("test") && !l.includes("─"))
    expect(badgeLine).not.toMatch(/root\s+\d+s/)
  })
})

// ─── 5. Concurrency / parallel ───────────────────────────────────────────────

describe("5. concurrency / parallel", () => {
  it("5-1: two children active simultaneously — both show spinner", () => {
    start("n1", "root")
    wait("n1", "root")
    start("n2", "child-a")
    start("n3", "child-b")
    expect(lineFor("root")).toContain("○")
    expect(lineFor("child-a")).toMatch(SPINNER_RE)
    expect(lineFor("child-b")).toMatch(SPINNER_RE)
  })

  it("5-2: child-a done, child-b still active", () => {
    start("n1", "root")
    wait("n1", "root")
    start("n2", "child-a")
    start("n3", "child-b")
    end("n2", "child-a")
    expect(lineFor("child-a")).toContain("✓")
    expect(lineFor("child-b")).toMatch(SPINNER_RE)
  })

  it("5-3: both children done → parent resumed, then done", () => {
    start("n1", "root")
    wait("n1", "root")
    start("n2", "child-a")
    start("n3", "child-b")
    end("n2", "child-a")
    end("n3", "child-b")
    resumed("n1", "root")
    end("n1", "root")
    expect(lineFor("root")).toContain("✓")
    expect(lineFor("child-a")).toContain("✓")
    expect(lineFor("child-b")).toContain("✓")
  })

  it("5-4: 3-level sequential — root → child-a → leaf-a1", () => {
    start("n1", "root")
    wait("n1", "root")
    start("n2", "child-a")
    wait("n2", "child-a")
    start("n3", "leaf-a1")

    expect(lineFor("root")).toContain("○")
    expect(lineFor("child-a")).toContain("○")
    expect(lineFor("leaf-a1")).toMatch(SPINNER_RE)
  })

  it("5-5: 3-level parallel — child-a spawns leaf-a1 and leaf-a2 simultaneously", () => {
    start("n1", "root")
    wait("n1", "root")
    start("n2", "child-a")
    wait("n2", "child-a")
    start("n3", "leaf-a1")
    start("n4", "leaf-a2")

    expect(lineFor("child-a")).toContain("○")
    expect(lineFor("leaf-a1")).toMatch(SPINNER_RE)
    expect(lineFor("leaf-a2")).toMatch(SPINNER_RE)
  })
})

// ─── 6. Pause / Resume ───────────────────────────────────────────────────────

describe("6. pause / resume", () => {
  it("6-1: pause while root active — root shows ⏸", () => {
    start("n1", "root")
    pause("n1", "root")
    expect(lineFor("root")).toContain("⏸")
  })

  it("6-2: pause while root waiting + child active — both show ⏸", () => {
    start("n1", "root")
    wait("n1", "root")
    start("n2", "child-a")
    pause("n1", "root")
    pause("n2", "child-a")
    expect(lineFor("root")).toContain("⏸")
    expect(lineFor("child-a")).toContain("⏸")
  })

  it("6-3: unpause clears ⏸, active agents resume spinner", () => {
    start("n1", "root")
    pause("n1", "root")
    expect(lineFor("root")).toContain("⏸")
    unpause("n1", "root")
    // after resume, still active so spinner shows
    expect(lineFor("root")).toMatch(SPINNER_RE)
    expect(lineFor("root")).not.toContain("⏸")
  })

  it("6-4: pause does NOT clear runningStack — elapsed keeps showing (session is frozen, not stopped)", () => {
    start("n1", "root")
    pause("n1", "root")
    const out = joined()
    expect(out).toMatch(/root\s+\d+s/)
  })
})

// ─── 7. Error ────────────────────────────────────────────────────────────────

describe("7. error handling", () => {
  it("7-1: error status — panel shows same as done (no error marker)", () => {
    start("n1", "leaf-a1")
    end("n1", "leaf-a1", "error")
    const line = lineFor("leaf-a1")
    // known: panel has no distinct error state, shows ✓ same as done
    expect(line).toContain("✓")
    expect(line).not.toMatch(SPINNER_RE)
    expect(line).not.toContain("□")
  })

  it("7-2: after child errors, parent can be resumed", () => {
    start("n1", "root")
    wait("n1", "root")
    start("n2", "child-a")
    end("n2", "child-a", "error")
    resumed("n1", "root")

    // root should be active again (spinner), not waiting
    expect(lineFor("root")).toMatch(SPINNER_RE)
    expect(lineFor("root")).not.toContain("○")
  })
})

// ─── 8. Layout / width ───────────────────────────────────────────────────────

describe("8. layout / width", () => {
  it("8-1: narrow panel (10 chars) — lines truncated with ellipsis", () => {
    start("n1", "root")
    const lines = renderAt(10)
    // truncateToWidth adds ANSI resets, so compare by visibleWidth not .length
    expect(lines.every((l) => visibleWidth(l) <= 10)).toBe(true)
    expect(lines.some((l) => l.includes("…"))).toBe(true)
  })

  it("8-2: long agent name — renders without breaking layout", () => {
    const longNameTree: TeamNode = {
      name: "very-long-agent-name-here",
      label: "very-long-agent-name-here",
      children: [],
    }
    panel.clear()
    panel.init({ team: longNameTree, title: "test" })
    start("n1", "very-long-agent-name-here")
    const line = lineFor("very-long-agent-name-here")
    expect(line).toContain("very-long-agent-name-here")
    expect(line).toMatch(SPINNER_RE)
  })

  it("8-3: long activity text — truncated in narrow panel", () => {
    const longText = "a".repeat(200)
    start("n1", "root")
    activity("n1", longText)
    const lines = renderAt(10)
    expect(lines.every((l) => visibleWidth(l) <= 10)).toBe(true)
    expect(lines.some((l) => l.includes("…"))).toBe(true)
  })

  it("8-4: deep nesting (4 levels) — indent structure correct", () => {
    const deepTree: TeamNode = {
      name: "l0",
      label: "l0",
      children: [
        {
          name: "l1",
          label: "l1",
          children: [
            {
              name: "l2",
              label: "l2",
              children: [{ name: "l3", label: "l3", children: [] }],
            },
          ],
        },
      ],
    }
    panel.clear()
    panel.init({ team: deepTree, title: "test" })
    const out = joined()
    // each level should appear, deeper levels are indented further
    const l0line = render().find((l) => l.includes("l0"))!
    const l3line = render().find((l) => l.includes("l3"))!
    // l3 has more leading whitespace than l0
    const leadingSpaces = (s: string) => s.match(/^(\s*)/)?.[1].length ?? 0
    expect(leadingSpaces(l3line)).toBeGreaterThan(leadingSpaces(l0line))
  })
})
