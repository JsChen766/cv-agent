import { randomUUID } from "node:crypto";

export type AgentTraceStepType =
  | "reason"
  | "plan"
  | "tool_call"
  | "confirmation_required"
  | "tool_result"
  | "error"
  | "final";

export type AgentTraceStepStatus =
  | "pending"
  | "running"
  | "success"
  | "needs_input"
  | "failed";

export type AgentTrace = {
  runId: string;
  steps: AgentTraceStep[];
};

export type AgentTraceStep = {
  id: string;
  agentName: string;
  type: AgentTraceStepType;
  summary: string;
  toolName?: string;
  status?: AgentTraceStepStatus;
  startedAt: string;
  completedAt?: string;
  metadata?: Record<string, unknown>;
};

export class AgentTraceRecorder {
  public readonly trace: AgentTrace;

  public constructor(runId = `arun-${randomUUID()}`) {
    this.trace = { runId, steps: [] };
  }

  public add(step: Omit<AgentTraceStep, "id" | "startedAt"> & { id?: string; startedAt?: string }): AgentTraceStep {
    const item: AgentTraceStep = {
      id: step.id ?? `step-${randomUUID()}`,
      agentName: step.agentName,
      type: step.type,
      summary: step.summary,
      toolName: step.toolName,
      status: step.status,
      startedAt: step.startedAt ?? new Date().toISOString(),
      completedAt: step.completedAt,
      metadata: step.metadata,
    };
    this.trace.steps.push(item);
    return item;
  }

  public complete(step: AgentTraceStep, status: AgentTraceStepStatus = "success", metadata?: Record<string, unknown>): void {
    step.status = status;
    step.completedAt = new Date().toISOString();
    step.metadata = metadata ? { ...(step.metadata ?? {}), ...metadata } : step.metadata;
  }
}
