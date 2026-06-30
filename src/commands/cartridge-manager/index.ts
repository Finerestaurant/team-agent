import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import * as fs from "node:fs"
import * as path from "node:path"
import * as panel from "../../ui/panel.ts"
import { handleCreateCartridge } from "./creator.ts"

const CARTRIDGE_DIR = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "../../..",
  "cartridge",
)

type CartridgeInfo = { name: string; description: string }

function scanInstalled(): CartridgeInfo[] {
  try {
    return fs
      .readdirSync(CARTRIDGE_DIR, { withFileTypes: true })
      .filter((e) => {
        if (e.name.startsWith(".") || e.name === "README.md") return false
        const full = path.join(CARTRIDGE_DIR, e.name)
        return e.isDirectory() || (e.isSymbolicLink() && fs.existsSync(full))
      })
      .flatMap((e) => {
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(CARTRIDGE_DIR, e.name, "package.json"), "utf-8"))
          return [{ name: e.name, description: pkg.description ?? e.name }]
        } catch {
          return [{ name: e.name, description: e.name }]
        }
      })
  } catch { return [] }
}

function getActive(): string | undefined {
  const p = path.join(CARTRIDGE_DIR, ".active")
  return fs.existsSync(p) ? fs.readFileSync(p, "utf-8").trim() : undefined
}

function removeCartridge(name: string): void {
  const targetDir = path.join(CARTRIDGE_DIR, name)
  const stat = fs.lstatSync(targetDir)
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(targetDir)
  } else {
    fs.rmSync(targetDir, { recursive: true, force: true })
  }
  if (getActive() === name) fs.rmSync(path.join(CARTRIDGE_DIR, ".active"), { force: true })
}

const CREATE_OPTION = "  ✦  Create new cartridge…"

export function register(pi: ExtensionAPI): void {
  pi.registerCommand("cartridge-manager", {
    description: "Manage installed team-agent cartridges",
    handler: async (_args, ctx) => {
      const cartridges = scanInstalled()
      const active = getActive()

      // ● active  ○ installed (not active)
      const options = cartridges.map((c) =>
        c.name === active
          ? `\x1b[32m●\x1b[0m \x1b[1m${c.name}\x1b[0m  ${c.description}`
          : `\x1b[33m○\x1b[0m \x1b[1m${c.name}\x1b[0m  ${c.description}`
      )
      options.push(CREATE_OPTION)

      const selected = await ctx.ui.select("Cartridge Manager", options)
      if (!selected) return

      if (selected === CREATE_OPTION) {
        await handleCreateCartridge(ctx, pi)
        return
      }

      const cartridge = cartridges[options.indexOf(selected)]!
      const isActive = cartridge.name === active

      const subOptions = isActive ? ["Remove"] : ["Activate", "Remove"]
      const action = await ctx.ui.select(cartridge.name, subOptions)
      if (!action) return

      if (action === "Activate") {
        try {
          fs.writeFileSync(path.join(CARTRIDGE_DIR, ".active"), cartridge.name)
          const mod = await import(path.join(CARTRIDGE_DIR, cartridge.name, "src", "index.ts"))
          if (typeof mod.default === "function") {
            mod.default(pi)
            panel.bindUI(ctx)
          }
          ctx.ui.notify(`✓ ${cartridge.name} activated`, "info")
        } catch (e) {
          ctx.ui.notify(`Failed: ${e instanceof Error ? e.message : String(e)}`, "error")
        }
      } else if (action === "Remove") {
        const ok = await ctx.ui.confirm("Remove cartridge", `Delete "${cartridge.name}"? This cannot be undone.`)
        if (!ok) return
        try {
          removeCartridge(cartridge.name)
          panel.init()
          panel.setStatus("No cartridge — run /cartridge-manager to install")
          panel.bindUI(ctx)
          ctx.ui.notify(`✓ ${cartridge.name} removed`, "info")
        } catch (e) {
          ctx.ui.notify(`Failed: ${e instanceof Error ? e.message : String(e)}`, "error")
        }
      }
    },
  })
}
