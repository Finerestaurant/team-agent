import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import * as fs from "node:fs"
import * as path from "node:path"
import { register as registerCartridgeManager } from "./commands/cartridge-manager/index.ts"
import * as panel from "./ui/panel.ts"

const CARTRIDGE_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "cartridge")

function findActive(): string | undefined {
  const activePath = path.join(CARTRIDGE_DIR, ".active")
  if (fs.existsSync(activePath)) {
    const name = fs.readFileSync(activePath, "utf-8").trim()
    if (name) return name
  }
  try {
    for (const entry of fs.readdirSync(CARTRIDGE_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const idx = path.join(CARTRIDGE_DIR, entry.name, "src", "index.ts")
      if (fs.existsSync(idx)) return entry.name
    }
  } catch {}
  return undefined
}

// Top-level await: Bun resolves this before pi calls the default export,
// so session_start and all other handlers are registered synchronously.
const active = findActive()
let cartridgeSetup: ((pi: ExtensionAPI) => void) | undefined

if (active) {
  const indexPath = path.join(CARTRIDGE_DIR, active, "src", "index.ts")
  try {
    const mod = await import(indexPath)
    if (typeof mod.default === "function") cartridgeSetup = mod.default
  } catch (e) {
    console.error(`[team-agent] failed to load cartridge "${active}": ${e instanceof Error ? e.message : String(e)}`)
  }
}

export default function teamAgent(pi: ExtensionAPI): void {
  registerCartridgeManager(pi)

  if (cartridgeSetup) {
    cartridgeSetup(pi)
  } else {
    panel.init()
    panel.setStatus("No cartridge — run /cartridge-manager to install")
    pi.on("session_start", (_event, ctx) => { panel.bindUI(ctx) })
    pi.on("session_shutdown", (_event, ctx) => { panel.unbindUI(ctx) })
  }
}
