import type {
  EvidenceCoverage,
  EvidenceItem,
  EvidenceQuality,
  EvidenceQualitySignal,
  EvidenceRecommendedAction,
  JDRequirement,
} from "./types.js";

export class EvidenceQualityScorer {
  public score(requirement: JDRequirement, evidenceItems: EvidenceItem[]): {
    coverage: EvidenceCoverage;
    recommendedAction: EvidenceRecommendedAction;
    signal: EvidenceQualitySignal;
  } {
    if (evidenceItems.length === 0) {
      const askUser = requirement.retrievalPolicies.includes("ask_user_required")
        || requirement.evidenceType === "need_user_confirmation";
      return {
        coverage: "no_evidence",
        recommendedAction: askUser ? "ask_user" : requirement.importance === "low" ? "ignore" : "alternative_angle",
        signal: {
          requirementId: requirement.id,
          quality: "missing",
          confidence: 0,
          reason: "No claim-level evidence was found for this JD requirement after persistent and corrective retrieval.",
        },
      };
    }

    const sorted = [...evidenceItems].sort((a, b) => b.confidence - a.confidence);
    const maxConfidence = sorted[0]?.confidence ?? 0;
    const secondConfidence = sorted[1]?.confidence ?? 0;
    const corroborationBonus = secondConfidence >= 0.55 ? 0.06 : 0;
    const highRisk = evidenceItems.some((item) => item.riskLevel === "high");
    const mediumRisk = evidenceItems.some((item) => item.riskLevel === "medium");
    const strict = requirement.strictness === "strict"
      || requirement.retrievalPolicies.includes("claim_verification")
      || requirement.retrievalPolicies.includes("ask_user_required");
    const adjustedConfidence = Math.max(0, Math.min(1, maxConfidence + corroborationBonus - (highRisk ? 0.18 : mediumRisk ? 0.07 : 0)));

    let quality: EvidenceQuality;
    if (adjustedConfidence >= (strict ? 0.78 : 0.72) && !highRisk) quality = "strong";
    else if (adjustedConfidence >= (strict ? 0.58 : 0.5)) quality = "medium";
    else quality = "weak";

    const coverage: EvidenceCoverage = quality === "strong" ? "covered" : "partially_covered";
    const recommendedAction: EvidenceRecommendedAction = strict && quality !== "strong"
      ? "ask_user"
      : quality === "weak" && requirement.importance === "low"
        ? "ignore"
        : "use";

    return {
      coverage,
      recommendedAction,
      signal: {
        requirementId: requirement.id,
        quality,
        confidence: Number(adjustedConfidence.toFixed(3)),
        reason: buildReason(quality, strict, highRisk, mediumRisk, evidenceItems.length),
      },
    };
  }
}

function buildReason(
  quality: EvidenceQuality,
  strict: boolean,
  highRisk: boolean,
  mediumRisk: boolean,
  count: number,
): string {
  if (highRisk) return "Evidence exists, but at least one candidate claim contains ambiguous ownership, metrics, or impact language and must be confirmed.";
  if (mediumRisk) return "Evidence exists with moderate factual risk; conservative wording or user confirmation is recommended.";
  if (quality === "strong") return count > 1
    ? "Multiple evidence items provide strong support for this requirement."
    : "A high-confidence claim provides direct support for this requirement.";
  if (quality === "medium") return strict
    ? "Evidence is relevant but not strong enough for an ownership, metric, or other strict factual claim without confirmation."
    : "Evidence provides partial support and should be expressed conservatively.";
  return "Only weakly related evidence was found; do not present this requirement as a verified strength.";
}
