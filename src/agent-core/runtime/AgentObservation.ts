export type AgentObservationStatus = "success" | "failed" | "needs_input" | "needs_confirmation";

export type AgentObservation = {
  id: string;
  stepId: string;
  agentName: string;
  toolName?: string;
  status: AgentObservationStatus;
  message?: string;
  data?: unknown;
  createdAt: string;
};

export type AgentLoopStopReason =
  | "final"
  | "needs_input"
  | "needs_confirmation"
  | "max_steps"
  | "failed"
  | "critic_blocked"
  | "critic_needs_revision";

export type AgentLoopState = {
  observations: AgentObservation[];
  stepCount: number;
  maxSteps: number;
  stopReason?: AgentLoopStopReason;
};

const DEFAULT_MAX_STEPS = 3;
const ABSOLUTE_MAX_STEPS = 6;

export function resolveAgentLoopMaxSteps(value = process.env.AGENT_LOOP_MAX_STEPS): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_MAX_STEPS;
  return Math.min(parsed, ABSOLUTE_MAX_STEPS);
}
