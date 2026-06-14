import type { EvidenceItem } from "../evidence/EvidenceItem.js";

export type LearningEventType =
  | "variant.accepted"
  | "variant.rejected"
  | "variant.revised"
  | "experience.saved"
  | "experience.updated"
  | "jd.saved"
  | "tool.failed"
  | "critic.needs_revision"
  | "critic.blocked"
  | "generation.completed"
  | "export.completed"
  | "user.preference_signal";

export type LearningEvent = {
  id: string;
  type: LearningEventType;
  userId: string;
  sessionId?: string;
  turnId?: string;
  source?: string;
  payload?: Record<string, unknown>;
  evidence?: EvidenceItem[];
  createdAt: string;
};
