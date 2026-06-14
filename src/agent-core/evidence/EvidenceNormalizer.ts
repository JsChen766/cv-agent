import type { EvidenceBundle } from "./EvidenceBundle.js";
import type { EvidenceItem } from "./EvidenceItem.js";

export type EvidenceNormalizationInput = EvidenceBundle | readonly EvidenceItem[] | undefined;

export class EvidenceNormalizer {
  public normalize(input: EvidenceNormalizationInput): EvidenceBundle {
    if (input === undefined) return { items: [] };
    if (Array.isArray(input)) return { items: [...input] };
    const bundle = input as EvidenceBundle;
    return {
      ...bundle,
      items: [...bundle.items],
      missing: bundle.missing ? [...bundle.missing] : undefined,
      risks: bundle.risks ? [...bundle.risks] : undefined,
    };
  }
}
