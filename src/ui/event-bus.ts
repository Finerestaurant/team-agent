import { EventEmitter } from "node:events"

export type TeamAgentEvent =
  | { type: "agent:start"; nodeId: string; agentName: string; isBackground?: boolean; taskId?: string }
  | { type: "agent:end"; nodeId: string; agentName: string; status: "done" | "error" | "cancelled"; isBackground?: boolean; taskId?: string; result?: string }
  | { type: "agent:waiting"; nodeId: string; agentName: string }
  | { type: "agent:resumed"; nodeId: string; agentName: string }
  | { type: "agent:paused"; nodeId: string; agentName: string }
  | { type: "agent:unpaused"; nodeId: string; agentName: string }
  | { type: "tool:start"; nodeId: string; toolName: string; args?: unknown }
  | { type: "tool:end"; nodeId: string; toolName: string; isError: boolean }
  | { type: "agent:activity"; nodeId: string; text: string }

const emitter = new EventEmitter()
emitter.setMaxListeners(50)

type Listener<T extends TeamAgentEvent["type"]> = (event: Extract<TeamAgentEvent, { type: T }>) => void

export function emit(event: TeamAgentEvent): void {
  emitter.emit(event.type, event)
}

export function on<T extends TeamAgentEvent["type"]>(type: T, listener: Listener<T>): () => void {
  emitter.on(type, listener as never)
  return () => emitter.off(type, listener as never)
}
