import type { AgentName } from "../validation/AgentOutputSchemas.js";

export type AgentStreamEventType =
  | "agent.turn.started"
  | "agent.thinking"
  | "agent.reasoning.delta"
  | "agent.reasoning.snapshot"
  | "agent.plan.snapshot"
  | "agent.tool.summary"
  | "agent.route.started"
  | "agent.route.completed"
  | "agent.agent.started"
  | "agent.agent.completed"
  | "agent.tool.started"
  | "agent.tool.completed"
  | "agent.tool.failed"
  | "agent.pending_action.created"
  | "agent.critic.started"
  | "agent.critic.completed"
  | "agent.workspace.updated"
  | "agent.message.delta"
  | "agent.message.completed"
  | "agent.completed"
  | "agent.failed";

export type AgentStreamEvent = {
  type: AgentStreamEventType;
  sessionId: string;
  turnId: string;
  createdAt: string;
  label: string;
  agentName?: AgentName | "AgentOrchestrator" | "ToolExecutor";
  toolName?: string;
  status?: string;
  message?: string;
  payload?: Record<string, unknown>;
  response?: unknown;
};

export type AgentRuntimeEmitter = (event: AgentStreamEvent) => void;
