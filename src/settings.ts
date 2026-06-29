import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export type Settings = { panelBg?: string }

const SETTINGS_PATH = path.join(os.homedir(), ".team-agent", "settings.json")

export function readSettings(): Settings {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8")) as Settings }
  catch { return {} }
}

export function writeSettings(patch: Partial<Settings>): void {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true })
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify({ ...readSettings(), ...patch }, null, 2))
  } catch {}
}
