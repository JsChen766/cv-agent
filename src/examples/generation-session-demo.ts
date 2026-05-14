import { createInMemoryCooltoDemoService } from "../application/CooltoDemoService.js";
import {
  GenerationSessionManager,
  InMemoryGenerationSessionRepository,
} from "../application/sessions/index.js";
import type { GenerateResumeResponse } from "../api-contracts/generation.js";
import type { JDRequirement } from "../knowledge/types.js";

async function main() {
  const service = createInMemoryCooltoDemoService();
  const result = await service.run({
    userId: "session-demo-user",
    rawExperienceText: [
      "As a Senior Frontend Engineer at Acme Corp, I led a React and TypeScript design system project for 12 product teams.",
      "Built an accessible component library with WCAG practices and shared API integration patterns.",
      "Reduced bundle size by 40% through performance optimization, tree-shaking, and lazy loading.",
    ].join("\n"),
    jdText:
      "We need a senior frontend engineer with React, TypeScript, design system, accessibility, API integration, and performance optimization experience.",
    targetRole: "Senior Frontend Engineer",
  });

  const { generation, demoSupplementalGapAdded } = ensureSupplementalGapForDemo(
    result.generation,
  );
  const repo = new InMemoryGenerationSessionRepository();
  const manager = new GenerationSessionManager(repo);
  const session = await manager.createSession({ generation });

  const firstArtifact = generation.artifacts[0]?.artifact;
  const secondArtifact = generation.artifacts[1]?.artifact;
  if (firstArtifact) {
    await manager.decideArtifact({
      sessionId: session.id,
      artifactId: firstArtifact.id,
      decision: "accepted",
      note: "Strong and ready to use.",
    });
  }
  if (secondArtifact) {
    await manager.decideArtifact({
      sessionId: session.id,
      artifactId: secondArtifact.id,
      decision: "needs_revision",
      note: "Keep the evidence but tighten the wording.",
    });
  }

  const supplementalGap = generation.coverageGapReport.items.find(
    (item) =>
      item.gapType === "missing_artifact" &&
      item.supplementalArtifactSuggestions.length > 0,
  );
  if (supplementalGap) {
    await manager.decideCoverageGap({
      sessionId: session.id,
      requirementId: supplementalGap.requirement.id,
      decision: "generate_supplemental_artifact",
    });
    await manager.generateSupplementalArtifactDraft({
      sessionId: session.id,
      requirementId: supplementalGap.requirement.id,
    });
  } else {
    const evidenceGap = result.generation.coverageGapReport.items.find(
      (item) => item.gapType === "missing_evidence",
    );
    if (evidenceGap) {
      await manager.decideCoverageGap({
        sessionId: session.id,
        requirementId: evidenceGap.requirement.id,
        decision: "request_more_evidence",
      });
    }
  }

  const finalSession = await manager.getSession(session.id);
  const summary = await manager.getSummary(session.id);

  console.log("=== Generation Session ===");
  console.log(JSON.stringify({
    sessionId: finalSession?.id,
    status: finalSession?.status,
    demoSupplementalGapAdded,
    generationArtifactCount: finalSession?.generation.artifacts.length,
    supplementalDraftCount: finalSession?.supplementalArtifactDrafts.length,
  }, null, 2));

  console.log("\n=== Session Summary ===");
  console.log(JSON.stringify(summary, null, 2));

  console.log("\n=== Artifact Decisions ===");
  console.log(JSON.stringify(finalSession?.artifactDecisions, null, 2));

  console.log("\n=== Coverage Gap Decisions ===");
  console.log(JSON.stringify(finalSession?.coverageGapDecisions, null, 2));

  console.log("\n=== Supplemental Artifact Drafts ===");
  console.log(JSON.stringify(finalSession?.supplementalArtifactDrafts, null, 2));
}

function ensureSupplementalGapForDemo(generation: GenerateResumeResponse): {
  generation: GenerateResumeResponse;
  demoSupplementalGapAdded: boolean;
} {
  const existingGap = generation.coverageGapReport.items.some(
    (item) =>
      item.gapType === "missing_artifact" &&
      item.supplementalArtifactSuggestions.length > 0,
  );
  if (existingGap) {
    return { generation, demoSupplementalGapAdded: false };
  }

  const firstArtifact = generation.artifacts[0]?.artifact;
  const now = new Date().toISOString();
  const requirement: JDRequirement = {
    id: "req-session-demo-api-gap",
    userId: generation.userId,
    jdId: generation.jdId,
    description: "API integration coverage gap for session demo",
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
        "Session demo gap: supporting evidence exists, but no generated artifact currently targets this requirement.",
    }],
    evidenceRequestSuggestions: [],
    reason:
      "Session demo gap: relevant evidence exists, but no generated artifact currently targets this requirement.",
  };
  const coverageItem = {
    requirement,
    status: "evidence_available_but_not_used" as const,
    coveredByArtifactIds: [],
    supportingEvidenceIds: sourceEvidenceIds,
    supportingSkillIds: firstArtifact?.matchedSkillIds ?? [],
    reason:
      "Session demo gap: relevant evidence exists in the generated result but is not used by a dedicated artifact.",
    suggestions: ["Generate an additional bullet targeting this requirement."],
  };

  return {
    generation: {
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
        summary: `${generation.coverageGapReport.summary} Added one session demo supplemental gap.`,
      },
    },
    demoSupplementalGapAdded: true,
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
