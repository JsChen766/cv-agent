import type { EvidenceItem } from "./EvidenceItem.js";

export type EvidenceBundle = {
  items: EvidenceItem[];
  summary?: string;
  missing?: string[];
  risks?: string[];
};
