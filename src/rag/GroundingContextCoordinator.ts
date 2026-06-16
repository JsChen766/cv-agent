import type { EvidencePack } from "./evidence/index.js";
import type { InstructionPack } from "./guideline/index.js";
import type { GroundingContext, GroundingRequirementPlan } from "./types.js";

export class GroundingContextCoordinator {
  public build(input: { instructionPack?: InstructionPack; evidencePack?: EvidencePack }): GroundingContext {
    const evidencePack = input.evidencePack;
    const requirementPlan: GroundingRequirementPlan[] = evidencePack
      ? evidencePack.jdRequirements.map((requirement) => {
          const match = evidencePack.matchedEvidence.find((item) => item.requirementId === requirement.id);
          const claims = evidencePack.allowedClaims.filter((claim) => claim.requirementIds.includes(requirement.id));
          const evidenceStatus = match?.coverage === "covered"
            ? "supported"
            : match?.coverage === "partially_covered"
              ? "partial"
              : "missing";
          const action = evidenceStatus === "supported"
            ? "emphasize"
            : evidenceStatus === "partial"
              ? "conservative_wording"
              : match?.recommendedAction === "ask_user"
                ? "ask_user"
                : match?.recommendedAction === "alternative_angle"
                  ? "alternative_angle"
                  : "omit";
          return {
            requirementId: requirement.id,
            text: requirement.text,
            importance: requirement.importance,
            evidenceStatus,
            action,
            claimIds: claims.map((claim) => claim.claimId ?? claim.id),
            experienceIds: Array.from(new Set(claims.map((claim) => claim.experienceId))),
          };
        })
      : [];
    const supportedRequirements = requirementPlan.filter((item) => item.evidenceStatus === "supported").length;
    const partiallySupportedRequirements = requirementPlan.filter((item) => item.evidenceStatus === "partial").length;
    const missingRequirements = requirementPlan.filter((item) => item.evidenceStatus === "missing").length;
    const critical = evidencePack?.jdRequirements.filter((item) => item.importance === "critical" || item.importance === "high") ?? [];
    const supportedCritical = critical.filter((requirement) => requirementPlan.some((plan) => plan.requirementId === requirement.id && plan.evidenceStatus !== "missing")).length;
    const warnings = [
      ...(input.instructionPack?.quality?.warnings ?? []),
      ...(evidencePack?.diagnostics?.warnings ?? []),
      ...(missingRequirements > 0 ? [`${missingRequirements} JD requirement(s) have no verified evidence and must not be asserted.`] : []),
    ];
    return {
      version: "dual-rag-v1",
      instructionPack: input.instructionPack,
      evidencePack,
      requirementPlan,
      executionRules: [
        "Use the Instruction Pack to decide structure, prioritization, and role-appropriate wording.",
        "Use the Evidence Pack as the exclusive factual boundary.",
        "Emphasize supported requirements, use conservative wording for partial evidence, and omit or ask the user about missing evidence.",
        "Return only the claim IDs and experience IDs actually used in each generated variant.",
        "Never resolve a conflict by weakening a factual safety constraint; hard constraints override style preferences.",
      ],
      coverageSummary: {
        totalRequirements: requirementPlan.length,
        supportedRequirements,
        partiallySupportedRequirements,
        missingRequirements,
        criticalCoverageRate: critical.length > 0 ? Number((supportedCritical / critical.length).toFixed(3)) : 1,
      },
      diagnostics: {
        guidelineStatus: input.instructionPack?.quality?.status,
        evidenceQuality: evidencePack?.diagnostics?.retrievalEvaluation.overallQuality,
        warnings: Array.from(new Set(warnings)),
      },
    };
  }
}
