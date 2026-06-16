export type EvidenceSourceType = "experience" | "jd" | "resume" | "conversation" | "file" | "system";

export type EvidenceUsage = "support" | "risk" | "missing" | "preference" | "feedback";

export type EvidenceItem = {
  id: string;
  sourceType: EvidenceSourceType;
  sourceId?: string;
  text?: string;
  span?: {
    start?: number;
    end?: number;
  };
  confidence?: number;
  usage?: EvidenceUsage;
  metadata?: Record<string, unknown>;
};
