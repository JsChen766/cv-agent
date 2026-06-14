import type { EvidenceItem } from "../evidence/EvidenceItem.js";
import type { RetrievalScope } from "./RetrievalScope.js";

export type RetrievalResult = {
  id: string;
  scope: RetrievalScope;
  sourceId?: string;
  title?: string;
  text: string;
  score?: number;
  metadata?: Record<string, unknown>;
  evidence?: EvidenceItem[];
};
