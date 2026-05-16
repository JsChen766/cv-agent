import { createAgentEvent } from "./AgentEventSink.js";
import type { AgentEvent, AgentEventSink } from "./types.js";

export class CollectingAgentEventSink implements AgentEventSink {
  private readonly events: AgentEvent[] = [];

  public emit(event: Omit<AgentEvent, "id" | "timestamp">): void {
    this.events.push(createAgentEvent(event));
  }

  public getEvents(): AgentEvent[] {
    return [...this.events];
  }
}
