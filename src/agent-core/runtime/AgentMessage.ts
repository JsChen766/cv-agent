import type { AgentName } from "../validation/AgentOutputSchemas.js";

export type AgentMessageParticipant = AgentName | "orchestrator";

export type AgentMessageType =
  | "request"
  | "response"
  | "critique"
  | "revision_request"
  | "observation"
  | "review_request";

export type AgentMessage = {
  id: string;
  runId: string;
  turnId: string;
  from: AgentMessageParticipant;
  to: AgentMessageParticipant;
  type: AgentMessageType;
  content: string;
  payload?: unknown;
  createdAt: string;
};
