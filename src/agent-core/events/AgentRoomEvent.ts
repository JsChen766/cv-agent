/**
 * AgentRoomEvent — a visible event emitted by an agent in the "agent group chat".
 * Each event has a speaker (agentName), a content payload, and optional specialInfo
 * for rich visual cards (match matrix, evidence stack, variant compare, etc.).
 *
 * Phase 1: response-only (no persistence). Added as an optional `agentRoomEvents`
 * field alongside the existing CopilotChatResponse fields.
 */

export type AgentRoomAgentName =
  | "frontdesk"
  | "experience_receiver"
  | "strategist"
  | "architect"
  | "critic"
  | "system";

export type AgentRoomEventKind =
  | "agent_text"
  | "tool_call"
  | "tool_result"
  | "pending_action"
  | "special_info"
  | "error"
  | "system";

/**
 * Rich visual card types the frontend can render without guessing block types.
 * Each maps to a specific product-card or decision-card UI component.
 */
export type SpecialInfoKind =
  | "match_matrix"
  | "match_score_strip"
  | "evidence_stack"
  | "risk_callout"
  | "variant_compare_board"
  | "decision_panel"
  | "agent_activity_timeline"
  | "asset_capsule"
  | "writing_result"
  | "experience_candidate_form"
  | "jd_analysis_result"
  | "diff_block"
  | "metric_ribbon"
  | "export_receipt"
  | "job_status_strip";

export type AgentRoomEventVisibility =
  | "visible"
  | "internal"
  | "error_visible";

/**
 * Structured payload for special visual cards.
 * The shape mirrors ProductBlock.data but with explicit semantic typing.
 */
export type SpecialInfoPayload = {
  kind: SpecialInfoKind;
  title?: string;
  summary?: string;
  /** Primary data for the frontend card renderer */
  data?: Record<string, unknown>;
  /** Related resource ids (experience, jd, resume, generation) */
  relatedResourceIds?: {
    experienceIds?: string[];
    jdIds?: string[];
    resumeIds?: string[];
    generationIds?: string[];
  };
  /** Named actions the user can take from this card */
  actions?: Array<{
    id: string;
    type: string;
    label: string;
    variantId?: string;
    payload?: Record<string, unknown>;
  }>;
  /** Raw source block / tool result for deeplink */
  source?: {
    blockType?: string;
    toolName?: string;
    toolResultId?: string;
  };
};

/**
 * A single visible event from an agent in the agent room.
 */
export type AgentRoomEvent = {
  id: string;
  sessionId?: string;
  turnId?: string;
  agentName: AgentRoomAgentName;
  /** Display label shown above the agent's message bubble, e.g. "JD Analyst" */
  agentRoleLabel?: string;
  eventKind: AgentRoomEventKind;
  visibility: AgentRoomEventVisibility;
  /** Short human-readable text (shown as the message bubble or card title) */
  content: string;
  /** Optional rich card payload */
  specialInfo?: SpecialInfoPayload;
  /** Tool that triggered/relates to this event */
  relatedToolName?: string;
  relatedResourceIds?: {
    experienceIds?: string[];
    jdIds?: string[];
    resumeIds?: string[];
    generationIds?: string[];
  };
  createdAt: string;
  metadata?: Record<string, unknown>;
};
