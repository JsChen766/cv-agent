import type { ProductGeneratedVariant } from "../../product/types.js";
import type { EvidencePack } from "./types.js";
import { normalizeText, splitSentences, unique } from "./textUtils.js";

const RISKY_FACT_PATTERNS = [
  /\b(led|owned|drove|managed|launched|increased|improved|reduced|grew|delivered)\b/i,
  /\d+\s*(%|％|users?|clients?|customers?|reports?|projects?|days?|weeks?|months?)/i,
  /主导|负责|管理|上线|提升|增长|降低|用户|客户|报告|项目/,
];

export class ClaimSupportVerifier {
  public verifyVariants(variants: ProductGeneratedVariant[], evidencePack: EvidencePack): ProductGeneratedVariant[] {
    return variants.map((variant) => this.verifyVariant(variant, evidencePack));
  }

  private verifyVariant(variant: ProductGeneratedVariant, evidencePack: EvidencePack): ProductGeneratedVariant {
    const evidenceText = normalizeText(evidencePack.allowedClaims.map((claim) => `${claim.claim} ${claim.evidenceText}`).join("\n"));
    const sentences = splitSentences(variant.content, 30);
    const unsupportedClaims = sentences
      .filter((sentence) => RISKY_FACT_PATTERNS.some((pattern) => pattern.test(sentence)))
      .filter((sentence) => !isSupported(sentence, evidenceText));

    const missingEvidence = evidencePack.missingRequirements.map((item) => item.requirementText).slice(0, 8);
    const warnings = [
      ...(variant.riskSummary?.warnings ?? []),
      ...(unsupportedClaims.length > 0 ? ["Some generated factual or impact claims were not directly supported by the Evidence Pack."] : []),
      ...(missingEvidence.length > 0 ? ["Some JD requirements have no verified user experience evidence."] : []),
    ];

    const sourceExperienceIds = unique([
      ...(variant.sourceExperienceIds ?? []),
      ...evidencePack.allowedClaims.map((claim) => claim.experienceId),
    ]).slice(0, 12);
    const sourceEvidenceIds = unique([
      ...(variant.sourceEvidenceIds ?? []),
      ...evidencePack.allowedClaims.map((claim) => claim.id),
    ]).slice(0, 20);

    const level = unsupportedClaims.length > 0 ? "high" : missingEvidence.length > 0 ? "medium" : variant.riskSummary?.level ?? "low";
    return {
      ...variant,
      sourceExperienceIds,
      sourceEvidenceIds,
      evidenceSummary: variant.evidenceSummary ?? buildEvidenceSummary(evidencePack),
      riskSummary: {
        level,
        unsupportedClaims: unique([...(variant.riskSummary?.unsupportedClaims ?? []), ...unsupportedClaims]).slice(0, 12),
        missingEvidence: unique([...(variant.riskSummary?.missingEvidence ?? []), ...missingEvidence]).slice(0, 12),
        warnings: unique(warnings).slice(0, 8),
      },
      missingInfo: unique([...(variant.missingInfo ?? []), ...missingEvidence.map((item) => `Add or confirm evidence for: ${item}`)]).slice(0, 12),
    };
  }
}

function isSupported(sentence: string, evidenceText: string): boolean {
  const terms = normalizeText(sentence).split(/\s+/).filter((term) => term.length >= 3);
  if (terms.length === 0) return true;
  const matched = terms.filter((term) => evidenceText.includes(term));
  return matched.length / Math.max(1, Math.min(terms.length, 10)) >= 0.45;
}

function buildEvidenceSummary(evidencePack: EvidencePack): ProductGeneratedVariant["evidenceSummary"] {
  const items = evidencePack.allowedClaims.slice(0, 6).map((claim) => ({
    id: claim.id,
    title: claim.claim.slice(0, 80),
    explanation: `Supported by ${claim.experienceId}: ${claim.evidenceText}`,
    confidence: claim.confidence,
  }));
  return {
    coverageLabel: evidencePack.missingRequirements.length > 0
      ? `Evidence Pack covers ${Math.max(0, evidencePack.jdRequirements.length - evidencePack.missingRequirements.length)} of ${evidencePack.jdRequirements.length} JD requirements.`
      : "Evidence Pack provides verified claims for the JD requirements.",
    items,
  };
}
