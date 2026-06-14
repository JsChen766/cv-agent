export type MemoryRecordType = "preference" | "strategy" | "feedback" | "summary" | "skill_gap" | "system";

export type MemoryRecord = {
  id: string;
  userId: string;
  type: MemoryRecordType;
  text: string;
  weight?: number;
  source?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
};
