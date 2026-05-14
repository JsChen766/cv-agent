import type { GenerateResumeResponse } from "../../api-contracts/generation.js";
import type { JDRequirement } from "../../knowledge/types.js";

export function addForcedSupplementalGapForDemo(
  generation: GenerateResumeResponse,
): GenerateResumeResponse {
  const existingGap = generation.coverageGapReport.items.some(
    (item) =>
      item.gapType === "missing_artifact" &&
      item.supplementalArtifactSuggestions.length > 0,
  );
  if (existingGap) {
    return generation;
  }

  const firstArtifact = generation.artifacts[0]?.artifact;
  const now = new Date().toISOString();
  const requirement: JDRequirement = {
    id: "req-session-demo-api-gap",
    userId: generation.userId,
    jdId: generation.jdId,
    description: "API integration coverage gap for forced session demo",
    requiredSkillIds: firstArtifact?.matchedSkillIds ?? [],
    weight: 0.5,
    createdAt: now,
  };
  const sourceEvidenceIds = firstArtifact?.sourceEvidenceIds.slice(0, 1) ?? [];
  const sourceExperienceIds = firstArtifact?.sourceExperienceIds.slice(0, 1) ?? [];
  const gapItem = {
    requirement,
    gapType: "missing_artifact" as const,
    severity: "medium" as const,
    existingEvidenceIds: sourceEvidenceIds,
    existingArtifactIds: [],
    supplementalArtifactSuggestions: [{
      type: "resume_bullet" as const,
      content:
        "Applied API integration patterns from existing frontend implementation evidence.",
      sourceExperienceIds,
      sourceEvidenceIds,
      matchedSkillIds: firstArtifact?.matchedSkillIds ?? [],
      targetRequirementIds: [requirement.id],
      confidence: 0.75,
      riskLevel: "low" as const,
      rationale:
        "Forced session demo gap: supporting evidence exists, but no generated artifact currently targets this requirement.",
    }],
    evidenceRequestSuggestions: [],
    reason:
      "Forced session demo gap: relevant evidence exists, but no generated artifact currently targets this requirement.",
  };
  const coverageItem = {
    requirement,
    status: "evidence_available_but_not_used" as const,
    coveredByArtifactIds: [],
    supportingEvidenceIds: sourceEvidenceIds,
    supportingSkillIds: firstArtifact?.matchedSkillIds ?? [],
    reason:
      "Forced session demo gap: relevant evidence exists in the generated result but is not used by a dedicated artifact.",
    suggestions: ["Generate an additional bullet targeting this requirement."],
  };

  return {
    ...generation,
    requirements: [...generation.requirements, requirement],
    coverageReport: {
      ...generation.coverageReport,
      totalRequirements: generation.coverageReport.totalRequirements + 1,
      evidenceAvailableButNotUsedRequirementIds: [
        ...generation.coverageReport.evidenceAvailableButNotUsedRequirementIds,
        requirement.id,
      ],
      items: [...generation.coverageReport.items, coverageItem],
    },
    coverageGapReport: {
      ...generation.coverageGapReport,
      items: [...generation.coverageGapReport.items, gapItem],
      supplementalArtifactCount:
        generation.coverageGapReport.supplementalArtifactCount + 1,
      summary: `${generation.coverageGapReport.summary} Added one forced session demo supplemental gap.`,
    },
  };
}
