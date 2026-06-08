import type { EvidenceCoverage, EvidenceQuality, EvidenceQualitySignal, EvidenceRecommendedAction, JDRequirement, EvidenceItem } from "./types.js";

export class EvidenceQualityScorer {
  public score(requirement: JDRequirement, evidenceItems: EvidenceItem[]): {
    coverage: EvidenceCoverage;
    recommendedAction: EvidenceRecommendedAction;
    signal: EvidenceQualitySignal;
  } {
    if (evidenceItems.length === 0) {
      return {
        coverage: "no_evidence",
        recommendedAction: requirement.retrievalPolicies.includes("ask_user_required") ? "ask_user" : "alternative_angle",
        signal: {
          requirementId: requirement.id,
          quality: "missing",
          confidence: 0,
          reason: "No matching claim or experience evidence was found for this JD requirement.",
        },
      };
    }

    const maxConfidence = Math.max(...evidenceItems.map((item) => item.confidence));
    const risky = evidenceItems.some((item) => item.riskLevel !== "low");
    const strict = requirement.retrievalPolicies.includes("claim_verification") || requirement.retrievalPolicies.includes("ask_user_required");
    const quality: EvidenceQuality = maxConfidence >= 0.72 && !risky ? "strong" : maxConfidence >= 0.48 ? "medium" : "weak";
    const coverage: EvidenceCoverage = quality === "strong" ? "covered" : "partially_covered";
    const recommendedAction: EvidenceRecommendedAction = strict && quality !== "strong" ? "ask_user" : "use";
    return {
      coverage,
      recommendedAction,
      signal: {
        requirementId: requirement.id,
        quality,
        confidence: Number(maxConfidence.toFixed(3)),
        reason: risky
          ? "Matched evidence exists, but the claim may involve ownership, metrics, or impact wording that should be verified."
          : "Matched evidence can support this requirement.",
      },
    };
  }
}
