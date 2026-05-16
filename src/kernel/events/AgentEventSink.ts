import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentEventSink } from "./types.js";

export type AgentEventInput = Omit<AgentEvent, "id" | "timestamp">;

export function createAgentEvent(event: AgentEventInput): AgentEvent {
  return {
    id: `evt-${randomUUID()}`,
    timestamp: new Date().toISOString(),
    ...event,
  };
}

export function emitKernelStarted(
  sink: AgentEventSink | undefined,
  event: Omit<AgentEventInput, "type" | "status">,
): Promise<void> | void {
  return sink?.emit({ ...event, type: "kernel.started", status: "started" });
}

export function emitKernelCompleted(
  sink: AgentEventSink | undefined,
  event: Omit<AgentEventInput, "type" | "status">,
): Promise<void> | void {
  return sink?.emit({ ...event, type: "kernel.completed", status: "completed" });
}

export function emitKernelFailed(
  sink: AgentEventSink | undefined,
  event: Omit<AgentEventInput, "type" | "status">,
): Promise<void> | void {
  return sink?.emit({ ...event, type: "kernel.failed", status: "failed" });
}

export function emitAgentStarted(
  sink: AgentEventSink | undefined,
  event: Omit<AgentEventInput, "type" | "status">,
): Promise<void> | void {
  return sink?.emit({ ...event, type: "agent.started", status: "started" });
}

export function emitAgentCompleted(
  sink: AgentEventSink | undefined,
  event: Omit<AgentEventInput, "type" | "status">,
): Promise<void> | void {
  return sink?.emit({ ...event, type: "agent.completed", status: "completed" });
}

export function emitAgentFailed(
  sink: AgentEventSink | undefined,
  event: Omit<AgentEventInput, "type" | "status">,
): Promise<void> | void {
  return sink?.emit({ ...event, type: "agent.failed", status: "failed" });
}

export function emitToolStarted(
  sink: AgentEventSink | undefined,
  event: Omit<AgentEventInput, "type" | "status">,
): Promise<void> | void {
  return sink?.emit({ ...event, type: "tool.started", status: "started" });
}

export function emitToolCompleted(
  sink: AgentEventSink | undefined,
  event: Omit<AgentEventInput, "type" | "status">,
): Promise<void> | void {
  return sink?.emit({ ...event, type: "tool.completed", status: "completed" });
}

export function emitWarning(
  sink: AgentEventSink | undefined,
  event: Omit<AgentEventInput, "type">,
): Promise<void> | void {
  return sink?.emit({ ...event, type: "warning" });
}
