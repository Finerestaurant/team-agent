import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { Cartridge } from "./types.ts"
import * as panel from "./ui/panel.ts"
import { on } from "./ui/event-bus.ts"
import { createTaskTools, setRuntime, getRegistry } from "./core/task.ts"
import * as logger from "./core/logger.ts"
import { register as registerPanelBg, loadSavedBg } from "./commands/panel-bg.ts"

export function createExtension(cartridge: Cartridge): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI) => {
    const { taskTool, awaitTaskTool, checkTaskTool, resumeChildTool, cancelChildTool } = createTaskTools(cartridge)
    const fullToolMap = {
      ...cartridge.tools,
      [awaitTaskTool.name]: awaitTaskTool,
      [checkTaskTool.name]: checkTaskTool,
      [resumeChildTool.name]: resumeChildTool,
      [cancelChildTool.name]: cancelChildTool,
    }
    setRuntime({ cartridge, toolMap: fullToolMap })

    panel.init({ team: cartridge.team, title: cartridge.title })
    loadSavedBg()

    registerPanelBg(pi)

    pi.registerTool(taskTool)
    pi.registerTool(resumeChildTool)
    pi.registerTool(cancelChildTool)

    pi.registerShortcut("ctrl+/", {
      description: "Pause current agent",
      handler: (ctx) => {
        const root = getRegistry().root()
        if (root?.status === "paused") {
          // Intentional no-op — if the keybinding directly triggered a blanket resume, that
          // would bypass root and let the framework reach into arbitrary depth directly,
          // violating the communication rule. Resume must always go through chat → resume_child
          // (root 1-hop only).
          return
        }
        if (root && (root.status === "active" || root.status === "waiting")) {
          logger.log(0, "team-agent", "PAUSE triggered", { root: root.agentName })
          getRegistry().pauseSubtree()
          pi.sendUserMessage(
            `[task_paused] ${root.agentName} was paused. check_task is still allowed for status questions. ` +
            `If the user gives a new instruction (even just "continue as-is"), call resume_child({ child: "${root.agentName}", instruction }). ` +
            `If the user says to stop/drop it, call cancel_child({ child: "${root.agentName}" }). ` +
            `Do NOT call task() to start new work while paused.`,
            { deliverAs: "followUp" },
          )
        } else {
          ctx.abort()
        }
      },
    })

    on("agent:end", ({ agentName, taskId, status, result }) => {
      if (agentName !== cartridge.rootAgent || !taskId) return
      if (status === "cancelled") return
      const msg = status === "done"
        ? `[task_complete] ${agentName} done:\n${result ?? ""}`
        : `[task_error] ${agentName} error: ${result ?? "unknown error"}`
      pi.sendUserMessage(msg, { deliverAs: "followUp" })
    })

    pi.on("session_start", (event, ctx) => {
      logger.log(0, "team-agent", "SESSION_START", { reason: event.reason })
      panel.bindUI(ctx)
    })
    pi.on("session_shutdown", (_event, ctx) => { panel.unbindUI(ctx) })

    pi.on("agent_start", () => {
      const root = getRegistry().root()
      const idle = !root || root.status === "done" || root.status === "error" || root.status === "cancelled"
      if (idle) panel.clear()
    })

    pi.on("input", (event) => {
      if (event.source === "interactive") {
        logger.log(0, "user", "INPUT", event.text.slice(0, 200))
      }
      if (event.source !== "interactive") return { action: "continue" }

      const root = getRegistry().root()
      if (root?.status === "paused") {
        return {
          action: "transform",
          text: `[paused: ${root.agentName}] check_task is allowed. Call resume_child({ child: "${root.agentName}", instruction }) ` +
            `to continue (even "just continue" needs an explicit call), or cancel_child({ child: "${root.agentName}" }) to stop.\nuser: ${event.text}`,
        }
      }
      if (root && (root.status === "active" || root.status === "waiting")) {
        return { action: "transform", text: `[in progress: ${root.agentName}]\nuser: ${event.text}` }
      }
      return { action: "continue" }
    })
  }
}
