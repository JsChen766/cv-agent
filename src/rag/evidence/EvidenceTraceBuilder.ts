import type {
  AllowedClaim,
  EvidenceRetrievalTrace,
  EvidenceUsageTrace,
  JDRequirement,
  RetrievedExperience,
  RetrievedPersistentClaim,
} from "./types.js";

export class EvidenceTraceBuilder {
  public retrievalTrace(retrieved: RetrievedExperience[]): EvidenceRetrievalTrace[] {
    return retrieved.map((item) => ({
      source: "raw_experience",
      experienceId: item.experience.id,
      title: item.experience.title,
      score: item.score,
      matchedTerms: item.matchedTerms,
      matchedRequirementIds: item.matchedRequirementIds,
      reason: item.reason,
      strategyScores: item.strategyScores,
      mode: item.mode,
    }));
  }

  public persistentClaimTrace(retrieved: RetrievedPersistentClaim[]): EvidenceRetrievalTrace[] {
    return retrieved.map((item) => ({
      source: "persistent_claim",
      experienceId: item.claim.experienceId,
      claimId: item.claim.id,
      graphEdgeIds: item.graphEdgeIds,
      title: String(item.claim.metadata.experienceTitle ?? item.claim.claim.slice(0, 90)),
      score: item.score,
      matchedTerms: item.matchedTerms,
      matchedRequirementIds: item.matchedRequirementIds,
      reason: item.reason,
      strategyScores: item.strategyScores,
      mode: item.mode,
    }));
  }

  public usageTrace(requirements: JDRequirement[], allowedClaims: AllowedClaim[]): EvidenceUsageTrace[] {
    return requirements.map((requirement) => {
      const claims = allowedClaims
        .filter((item) => item.requirementIds.includes(requirement.id))
        .sort((a, b) => b.confidence - a.confidence);
      const claim = claims[0];
      if (!claim) {
        return {
          requirementId: requirement.id,
          status: requirement.retrievalPolicies.includes("ask_user_required") ? "needs_user_confirmation" : "missing",
        };
      }
      return {
        requirementId: requirement.id,
        claimId: claim.claimId ?? claim.id,
        experienceId: claim.experienceId,
        evidenceText: claim.evidenceText,
        status: requirement.strictness === "strict" && claim.riskLevel !== "low" ? "needs_user_confirmation" : "available",
      };
    });
  }
}
