import type { AgentEvent, AgentEventSink } from "./types.js";

export class NoopAgentEventSink implements AgentEventSink {
  public emit(_event: Omit<AgentEvent, "id" | "timestamp">): void {
    // Intentionally empty.
  }
}
