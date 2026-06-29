import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import * as panel from "../ui/panel.ts"
import { readSettings, writeSettings } from "../settings.ts"

const BG_PRESETS: { name: string; label: string; ansi: string }[] = [
  { name: "none",     label: "None (default terminal)",  ansi: "" },
  { name: "midnight", label: "Midnight  #1c1c1c",        ansi: "\x1b[48;5;234m" },
  { name: "charcoal", label: "Charcoal  #303030",        ansi: "\x1b[48;5;236m" },
  { name: "slate",    label: "Slate     #3a3a3a",        ansi: "\x1b[48;5;237m" },
  { name: "navy",     label: "Navy      #00005f",        ansi: "\x1b[48;5;17m"  },
  { name: "forest",   label: "Forest    #005f00",        ansi: "\x1b[48;5;22m"  },
  { name: "maroon",   label: "Maroon    #5f0000",        ansi: "\x1b[48;5;52m"  },
]

export function applyBgByName(name: string | undefined): void {
  const preset = BG_PRESETS.find((p) => p.name === name)
  panel.setBg(preset && preset.ansi ? preset.ansi : undefined)
}

export function register(pi: ExtensionAPI): void {
  pi.registerCommand("panel-bg", {
    description: "Set panel background color",
    getArgumentCompletions: () =>
      BG_PRESETS.map((p) => ({ value: p.name, label: p.name, description: p.label })),
    handler: async (_args, ctx) => {
      const labels = BG_PRESETS.map((p) => {
        const swatch = p.ansi ? `${p.ansi}  \x1b[0m ` : "    "
        return `${swatch}${p.label}`
      })
      const selected = await ctx.ui.select("Panel background color", labels)
      if (!selected) return
      const idx = labels.indexOf(selected)
      if (idx < 0) return
      const preset = BG_PRESETS[idx]!
      applyBgByName(preset.name)
      writeSettings({ panelBg: preset.name })
      ctx.ui.notify(`Panel background: ${preset.label}`, "info")
    },
  })
}

export function loadSavedBg(): void {
  applyBgByName(readSettings().panelBg)
}
