export type AgentEventType =
  | "kernel.started"
  | "kernel.completed"
  | "kernel.failed"
  | "agent.started"
  | "agent.completed"
  | "agent.failed"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "llm.started"
  | "llm.completed"
  | "llm.repaired"
  | "llm.fallback"
  | "artifact.candidate.created"
  | "artifact.critique.completed"
  | "artifact.revision.completed"
  | "decision.required"
  | "warning";

export type AgentEvent = {
  id: string;
  type: AgentEventType;
  timestamp: string;
  requestId?: string;
  traceId?: string;
  agentName?: string;
  toolName?: string;
  step?: string;
  status?: "started" | "completed" | "failed";
  message: string;
  data?: Record<string, unknown>;
};

export interface AgentEventSink {
  emit(event: Omit<AgentEvent, "id" | "timestamp">): Promise<void> | void;
}
