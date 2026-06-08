import type { EvidenceRetrievalTrace, EvidenceUsageTrace, JDRequirement, RetrievedExperience, AllowedClaim } from "./types.js";

export class EvidenceTraceBuilder {
  public retrievalTrace(retrieved: RetrievedExperience[]): EvidenceRetrievalTrace[] {
    return retrieved.map((item) => ({
      experienceId: item.experience.id,
      title: item.experience.title,
      score: item.score,
      matchedTerms: item.matchedTerms,
      matchedRequirementIds: item.matchedRequirementIds,
      reason: item.reason,
    }));
  }

  public usageTrace(requirements: JDRequirement[], allowedClaims: AllowedClaim[]): EvidenceUsageTrace[] {
    return requirements.map((requirement) => {
      const claim = allowedClaims.find((item) => item.requirementIds.includes(requirement.id));
      if (!claim) {
        return {
          requirementId: requirement.id,
          status: requirement.retrievalPolicies.includes("ask_user_required") ? "needs_user_confirmation" : "missing",
        };
      }
      return {
        requirementId: requirement.id,
        claimId: claim.id,
        experienceId: claim.experienceId,
        evidenceText: claim.evidenceText,
        status: "available",
      };
    });
  }
}
