import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

const LOG_FILE = process.env.TEAM_AGENT_LOG_FILE ?? path.join(os.homedir(), ".team-agent", "logs", "agents.log")

let ready = false
function ensureDir(): void {
  if (ready) return
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
  } catch {}
  ready = true
}

function clip(s: string, max = 2000): string {
  const oneLine = s.replace(/\r?\n/g, "\\n")
  return oneLine.length > max ? `${oneLine.slice(0, max)}…(+${oneLine.length - max})` : oneLine
}

export function log(depth: number, agent: string, event: string, detail?: unknown): void {
  try {
    ensureDir()
    const ts = new Date().toISOString()
    const indent = "  ".repeat(Math.max(0, depth))
    let detailStr = ""
    if (detail !== undefined) {
      const raw = typeof detail === "string" ? detail : JSON.stringify(detail)
      detailStr = ` ${clip(raw)}`
    }
    fs.appendFileSync(LOG_FILE, `${ts} ${indent}[${agent}] ${event}${detailStr}\n`)
  } catch {}
}

export function logPanel(trigger: string, lines: string[]): void {
  try {
    ensureDir()
    const ts = new Date().toISOString()
    fs.appendFileSync(LOG_FILE, `${ts} [PANEL] ${trigger}\n${lines.join("\n")}\n\n`)
  } catch {}
}

export function logTree(trigger: string, lines: string[]): void {
  try {
    ensureDir()
    const ts = new Date().toISOString()
    fs.appendFileSync(LOG_FILE, `${ts} [TREE] ${trigger}\n${lines.join("\n")}\n\n`)
  } catch {}
}

export function logFilePath(): string {
  return LOG_FILE
}
