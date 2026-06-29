type PauseState = "idle" | "running" | "paused"

class PauseController {
  private _state: PauseState = "idle"
  private aborts = new Map<string, () => void>()

  register(taskId: string, abort: () => void): void {
    this.aborts.set(taskId, abort)
  }

  unregister(taskId: string): void {
    this.aborts.delete(taskId)
  }

  pause(): void {
    if (this._state !== "running") return
    this._state = "paused"
    for (const abort of this.aborts.values()) abort()
  }

  resume(): void {
    this._state = "running"
    this.aborts.clear()
  }

  markIdle(): void {
    if (this._state === "running") this._state = "idle"
  }

  get isPaused(): boolean { return this._state === "paused" }
  get isRunning(): boolean { return this._state === "running" }
}

export const pauseController = new PauseController()
