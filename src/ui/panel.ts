import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui"
import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent"
import type { TeamNode } from "../types.ts"
import { on } from "./event-bus.ts"
import * as logger from "../core/logger.ts"

const WIDGET_KEY = "team-agent"

type AgentState = { active: number; waiting: number; ranCount: number; currentTool?: string; activity?: string; paused?: boolean }
const stateByName = new Map<string, AgentState>()
const idToName = new Map<string, string>()
const runningStack: { nodeId: string; name: string; startedAt: number }[] = []

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

let activeCtx: ExtensionContext | undefined
let currentTeam: TeamNode | undefined
let currentTitle = "team"
let currentStatus: string | undefined
let currentBgAnsi: string | undefined
let lastTheme: Theme | undefined

let _wizardSavedTeam: TeamNode | undefined
let _wizardSavedTitle: string | undefined
let _detailLines: string[] = []

const PANEL_LOG_WIDTH = 50

function logPanel(trigger: string): void {
  if (!lastTheme) return
  logger.logPanel(trigger, buildLines(lastTheme, false, PANEL_LOG_WIDTH))
}

export function init(config?: { team?: TeamNode; title?: string }): void {
  currentTeam = config?.team
  currentTitle = config?.title ?? "team"
  currentStatus = undefined
}

export function setStatus(status: string | undefined): void {
  currentStatus = status
  render()
}

export function enterWizardMode(title: string): void {
  _wizardSavedTeam = currentTeam
  _wizardSavedTitle = currentTitle
  currentTeam = undefined
  currentTitle = title
  currentStatus = undefined
  _detailLines = []
  render()
}

export function exitWizardMode(): void {
  currentTeam = _wizardSavedTeam
  currentTitle = _wizardSavedTitle ?? "team"
  _wizardSavedTeam = undefined
  _wizardSavedTitle = undefined
  _detailLines = []
  render()
}

export function setDetail(lines: string[]): void {
  _detailLines = lines
  render()
}

export function clearDetail(): void {
  _detailLines = []
  render()
}

export function hide(): void {
  if (!activeCtx) return
  activeCtx.ui.setWidget(WIDGET_KEY, undefined)
  if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = undefined }
}

export function setBg(ansi: string | undefined): void {
  currentBgAnsi = ansi
  render()
}

export function getBg(): string | undefined {
  return currentBgAnsi
}

function st(name: string): AgentState {
  let s = stateByName.get(name)
  if (!s) {
    s = { active: 0, waiting: 0, ranCount: 0 }
    stateByName.set(name, s)
  }
  return s
}

// ---- spinner ----
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function spinnerGlyph(): string {
  return SPINNER_FRAMES[Math.floor(Date.now() / 80) % SPINNER_FRAMES.length]!
}

function anyActive(): boolean {
  for (const s of stateByName.values()) if (s.active > 0) return true
  return false
}

let spinnerTimer: ReturnType<typeof setInterval> | undefined

function syncSpinner(): void {
  const running = anyActive()
  if (running && !spinnerTimer) {
    spinnerTimer = setInterval(render, 80)
    spinnerTimer.unref?.()
  } else if (!running && spinnerTimer) {
    clearInterval(spinnerTimer)
    spinnerTimer = undefined
  }
}

// ---- event subscriptions (module load, once) ----

on("agent:start", ({ nodeId, agentName }) => {
  idToName.set(nodeId, agentName)
  const s = st(agentName)
  s.active += 1
  s.ranCount += 1
  runningStack.push({ nodeId, name: agentName, startedAt: Date.now() })
  render()
  logPanel(`agent:start ${agentName}`)
})

on("agent:end", ({ nodeId, agentName, status }) => {
  idToName.delete(nodeId)
  const s = st(agentName)
  s.active = Math.max(0, s.active - 1)
  s.waiting = 0
  if (s.active === 0) {
    s.currentTool = undefined
    s.activity = undefined
  }
  const idx = runningStack.findLastIndex((e) => e.nodeId === nodeId)
  if (idx >= 0) runningStack.splice(idx, 1)
  render()
  logPanel(`agent:end ${agentName} (${status})`)
})

on("agent:waiting", ({ agentName }) => {
  st(agentName).waiting += 1
  render()
  logPanel(`agent:waiting ${agentName}`)
})

on("agent:resumed", ({ agentName }) => {
  const s = st(agentName)
  s.waiting = Math.max(0, s.waiting - 1)
  render()
  logPanel(`agent:resumed ${agentName}`)
})

on("tool:start", ({ nodeId, toolName }) => {
  const name = idToName.get(nodeId)
  if (!name) return
  st(name).currentTool = toolName
  render()
  logPanel(`tool:start ${name} → ${toolName}`)
})

on("tool:end", ({ nodeId, toolName }) => {
  const name = idToName.get(nodeId)
  if (!name) return
  st(name).currentTool = undefined
  render()
  logPanel(`tool:end ${name} → ${toolName}`)
})

on("agent:activity", ({ nodeId, text }) => {
  const name = idToName.get(nodeId)
  if (!name) return
  st(name).activity = text
  render()
})

// ---- lifecycle ----

export function bindUI(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return
  activeCtx = ctx
  render()
}

export function unbindUI(ctx: ExtensionContext): void {
  if (activeCtx === ctx) activeCtx = undefined
  if (spinnerTimer) {
    clearInterval(spinnerTimer)
    spinnerTimer = undefined
  }
}

function markTreePaused(node: TeamNode): boolean {
  const s = stateByName.get(node.name)
  const selfActive = (s?.active ?? 0) > 0 || (s?.waiting ?? 0) > 0
  const childActive = node.children.some((c) => markTreePaused(c))
  if (selfActive || childActive) {
    st(node.name).paused = true
    return true
  }
  return false
}

export function onPause(): void {
  for (const s of stateByName.values()) {
    if (s.active > 0 || s.waiting > 0) s.paused = true
  }
  if (currentTeam) markTreePaused(currentTeam)
  runningStack.length = 0
  render()
  logPanel("pause")
}

export function onResume(): void {
  for (const s of stateByName.values()) s.paused = false
  render()
  logPanel("resume")
}

export function clear(): void {
  stateByName.clear()
  idToName.clear()
  runningStack.length = 0
  render()
  logPanel("clear")
}

// ---- rendering ----

function hasActiveDescendant(node: TeamNode): boolean {
  return node.children.some((c) => ((stateByName.get(c.name)?.active ?? 0) > 0) || hasActiveDescendant(c))
}

function renderNode(
  node: TeamNode,
  theme: Theme,
  prefix: string,
  isRoot: boolean,
  isLast: boolean,
  contColor: ThemeColor,
  expanded: boolean,
  width: number,
  lines: string[],
): void {
  const s = stateByName.get(node.name)
  const active = (s?.active ?? 0) > 0
  const waiting = active && (s?.waiting ?? 0) > 0
  const done = !active && (s?.ranCount ?? 0) > 0
  const activeOrBusy = active || hasActiveDescendant(node)

  const connectorColor = activeOrBusy ? "accent" : done ? "success" : "dim"
  const connector = isRoot ? "" : theme.fg(connectorColor, isLast ? "└─ " : "├─ ")

  let marker: string
  let label: string
  if (s?.paused) {
    marker = theme.fg("warning", "⏸")
    label = theme.fg("warning", node.label)
  } else if (waiting) {
    marker = theme.fg("warning", "○")
    label = theme.fg("warning", node.label)
  } else if (active) {
    marker = theme.fg("accent", spinnerGlyph())
    label = theme.fg("accent", theme.bold(node.label))
  } else if (done) {
    marker = theme.fg("success", "✓")
    label = theme.fg("text", node.label)
  } else {
    marker = theme.fg("dim", "□")
    label = theme.fg("dim", node.label)
  }
  const tool = active && !waiting && s?.currentTool ? ` ${theme.fg("dim", `[${s.currentTool}]`)}` : ""

  const childPrefix = prefix + (isRoot ? "" : theme.fg(contColor, isLast ? "   " : "│  "))
  const activityText = active && s?.activity ? s.activity.replace(/\s+/g, " ").trim() : ""
  const activitySuffix = activityText && !expanded ? theme.fg("dim", `: ${activityText}`) : ""
  lines.push(`${prefix}${connector}${marker} ${label}${tool}${activitySuffix}`)

  if (activityText && expanded) {
    const indent = `${childPrefix}  `
    const avail = Math.max(10, width - visibleWidth(indent))
    for (const wl of wrapTextWithAnsi(theme.fg("dim", activityText), avail)) lines.push(`${indent}${wl}`)
  }

  node.children.forEach((child, i) => {
    const isChildLast = i === node.children.length - 1
    const remainingSiblings = node.children.slice(i + 1)
    const sibActive = remainingSiblings.some(
      (sib) => (stateByName.get(sib.name)?.active ?? 0) > 0 || hasActiveDescendant(sib),
    )
    const sibDone = !sibActive && remainingSiblings.some((sib) => (stateByName.get(sib.name)?.ranCount ?? 0) > 0)
    const childContColor: ThemeColor = sibActive ? "accent" : sibDone ? "success" : "dim"
    renderNode(child, theme, childPrefix, false, isChildLast, childContColor, expanded, width, lines)
  })
}

const FRAMEWORK_NAME = "Team-Agent"

function buildLines(theme: Theme, expanded: boolean, width: number): string[] {
  // "─────── team-agent ───────────────────────────────"
  const leftFixed = "─────── "
  const trailingCount = Math.max(0, width - leftFixed.length - FRAMEWORK_NAME.length - 1)
  const topHr =
    theme.fg("border", leftFixed) +
    theme.fg("border", FRAMEWORK_NAME) +
    theme.fg("border", " " + "─".repeat(trailingCount))
  const bottomHr = theme.fg("border", "─".repeat(Math.max(1, width)))

  const root = runningStack[0]
  const agentStatus = root
    ? `${root.name}  ${formatElapsed(Date.now() - root.startedAt)}`
    : currentStatus
  const badge = agentStatus
    ? `${theme.fg("toolTitle", theme.bold(currentTitle))}  ${theme.fg("dim", agentStatus)}`
    : theme.fg("toolTitle", theme.bold(currentTitle))
  const inner: string[] = [badge]

  if (currentTeam) renderNode(currentTeam, theme, "", true, true, "dim", expanded, width - 1, inner)
  for (const line of _detailLines) inner.push(line)

  const hint = ` ${theme.fg("border", "ctrl+/")}  ${theme.fg("dim", "pause")}`
  return [topHr, "", ...inner.map((l) => ` ${l}`), "", hint, bottomHr]
}

function fitLines(theme: Theme, width: number, expanded: boolean): string[] {
  const w = Math.max(1, width)
  const lines = buildLines(theme, expanded, w).map((line) => truncateToWidth(line, w, "…"))
  if (!currentBgAnsi) return lines
  const bg = currentBgAnsi
  return lines.map((line) => {
    const pad = " ".repeat(Math.max(0, w - visibleWidth(line)))
    return `${bg}${line}${pad}\x1b[0m`
  })
}

function render(): void {
  syncSpinner()
  if (!activeCtx) return
  activeCtx.ui.setWidget(WIDGET_KEY, (_tui: unknown, theme: Theme): Component => {
    lastTheme = theme
    return {
      render: (width: number) => {
        lastTheme = theme
        return fitLines(theme, width, activeCtx?.ui.getToolsExpanded?.() ?? false)
      },
      invalidate: () => {},
    }
  })
}

export function debugRender(theme: Theme, expanded = false): string[] {
  return buildLines(theme, expanded, 9999)
}

export function debugRenderAt(theme: Theme, width: number, expanded = false): string[] {
  return fitLines(theme, width, expanded)
}
