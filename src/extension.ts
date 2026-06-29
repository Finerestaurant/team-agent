import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { Cartridge } from "./types.ts"
import * as panel from "./ui/panel.ts"
import { on } from "./ui/event-bus.ts"
import { createTaskTools, setRuntime } from "./core/task.ts"
import { pauseController } from "./core/pause.ts"
import * as logger from "./core/logger.ts"
import { register as registerPanelBg, loadSavedBg } from "./commands/panel-bg.ts"

export function createExtension(cartridge: Cartridge): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI) => {
    const { taskTool, awaitTaskTool, checkTaskTool } = createTaskTools(cartridge)
    const fullToolMap = {
      ...cartridge.tools,
      [awaitTaskTool.name]: awaitTaskTool,
      [checkTaskTool.name]: checkTaskTool,
    }
    setRuntime({ cartridge, toolMap: fullToolMap })

    panel.init({ team: cartridge.team, title: cartridge.title })
    loadSavedBg()

    registerPanelBg(pi)

    pi.registerShortcut("ctrl+/", {
      description: "Pause current agent",
      handler: (ctx) => {
        if (bgRunning.size > 0) {
          const running = [...bgRunning.values()].join(", ")
          logger.log(0, "team-agent", "PAUSE triggered", { running: [...bgRunning.values()] })
          pausedRunning = [...bgRunning.values()]
          pauseController.pause()
          panel.onPause()
          pi.sendUserMessage(
            `[task_paused] ${running} was paused. Do NOT call task(), check_task, or any other tool. Do NOT take any action. Simply tell the user the task is paused and wait silently for their next instruction.`,
            { deliverAs: "followUp" },
          )
        } else if (!pauseController.isPaused) {
          ctx.abort()
        }
      },
    })

    pi.registerTool(taskTool)

    const bgRunning = new Map<string, string>()
    let pausedRunning: string[] = []

    on("agent:start", ({ agentName, taskId }) => {
      if (agentName === cartridge.rootAgent && taskId) {
        bgRunning.clear()
        bgRunning.set(taskId, agentName)
        pausedRunning = []
        pauseController.resume()
        panel.onResume()
      }
    })

    on("agent:end", ({ agentName, taskId, status, result }) => {
      if (agentName !== cartridge.rootAgent || !taskId) return
      bgRunning.delete(taskId)
      if (pauseController.isPaused) {
        // pause signal already sent from ctrl+/ handler; just clean up silently
        return
      }
      pauseController.markIdle()
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
      if (bgRunning.size === 0 && !pauseController.isPaused) {
        panel.clear()
      }
    })

    pi.on("input", (event) => {
      if (event.source === "interactive") {
        logger.log(0, "user", "INPUT", event.text.slice(0, 200))
      }
      if (event.source !== "interactive") return { action: "continue" }
      if (pauseController.isPaused && pausedRunning.length > 0) {
        const names = pausedRunning.join(", ")
        return {
          action: "transform",
          text: `[paused: ${names}] Task is paused — do NOT call task() or check_task on your own. Wait for the user's explicit instruction before doing anything.\nuser: ${event.text}`,
        }
      }
      if (bgRunning.size === 0) return { action: "continue" }
      const running = [...bgRunning.values()].join(", ")
      return {
        action: "transform",
        text: `[in progress: ${running}]\nuser: ${event.text}`,
      }
    })
  }
}
