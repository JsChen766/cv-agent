import type { EvidencePack, RetrievalEvaluation } from "./types.js";
import { clamp, normalizeText } from "./textUtils.js";

export class RetrievalEvaluator {
  public evaluate(pack: EvidencePack): RetrievalEvaluation {
    const total = Math.max(1, pack.jdRequirements.length);
    const covered = pack.matchedEvidence.filter((item) => item.coverage !== "no_evidence").length;
    const criticalRequirements = pack.jdRequirements.filter((item) => item.importance === "critical" || item.importance === "high");
    const criticalCovered = criticalRequirements.filter((requirement) => {
      const match = pack.matchedEvidence.find((item) => item.requirementId === requirement.id);
      return match && match.coverage !== "no_evidence";
    }).length;
    const strong = pack.qualitySignals.filter((signal) => signal.quality === "strong").length;
    const duplicateRate = computeDuplicateRate(pack);
    const coverageRate = clamp(covered / total);
    const criticalCoverageRate = criticalRequirements.length > 0 ? clamp(criticalCovered / criticalRequirements.length) : 1;
    const strongEvidenceRate = clamp(strong / total);
    const correctionReasons: string[] = [];

    if (pack.allowedClaims.length === 0) correctionReasons.push("No allowed claims were produced.");
    if (criticalCoverageRate < 0.7) correctionReasons.push("Critical/high-priority JD coverage is below 70%.");
    if (coverageRate < 0.55) correctionReasons.push("Overall JD evidence coverage is below 55%.");
    if (duplicateRate > 0.45) correctionReasons.push("Retrieved evidence is overly concentrated in duplicate claims or experiences.");
    if (pack.qualitySignals.some((signal) => signal.quality === "weak" && isCritical(pack, signal.requirementId))) {
      correctionReasons.push("At least one critical requirement has only weak evidence.");
    }

    const correctionNeeded = correctionReasons.length > 0;
    const overallQuality: RetrievalEvaluation["overallQuality"] = !correctionNeeded && criticalCoverageRate >= 0.85 && coverageRate >= 0.7
      ? "sufficient"
      : pack.allowedClaims.length > 0 && (coverageRate >= 0.35 || criticalCoverageRate >= 0.5)
        ? "partial"
        : "insufficient";

    return {
      overallQuality,
      coverageRate,
      criticalCoverageRate,
      strongEvidenceRate,
      duplicateRate,
      correctionNeeded,
      correctionReasons,
    };
  }
}

function computeDuplicateRate(pack: EvidencePack): number {
  const claims = pack.allowedClaims;
  if (claims.length <= 1) return 0;
  const seen = new Set<string>();
  let duplicates = 0;
  for (const claim of claims) {
    const key = `${claim.experienceId}:${normalizeText(claim.claim)}`;
    if (seen.has(key)) duplicates += 1;
    else seen.add(key);
  }
  const experienceCounts = new Map<string, number>();
  for (const claim of claims) experienceCounts.set(claim.experienceId, (experienceCounts.get(claim.experienceId) ?? 0) + 1);
  const concentration = Math.max(0, ...experienceCounts.values()) / claims.length;
  return clamp(Math.max(duplicates / claims.length, concentration > 0.75 ? concentration - 0.5 : 0));
}

function isCritical(pack: EvidencePack, requirementId: string): boolean {
  const requirement = pack.jdRequirements.find((item) => item.id === requirementId);
  return requirement?.importance === "critical" || requirement?.importance === "high";
}
