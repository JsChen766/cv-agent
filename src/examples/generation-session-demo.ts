import { createInMemoryCooltoDemoService } from "../application/CooltoDemoService.js";
import {
  GenerationSessionManager,
  InMemoryGenerationSessionRepository,
} from "../application/sessions/index.js";

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

  const generation = result.generation;
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
    const evidenceGap = generation.coverageGapReport.items.find(
      (item) => item.gapType === "missing_evidence",
    );
    if (evidenceGap) {
      await manager.decideCoverageGap({
        sessionId: session.id,
        requirementId: evidenceGap.requirement.id,
        decision: "request_more_evidence",
      });
    } else {
      console.log("No coverage gap available for supplemental draft demo.");
    }
  }

  const finalSession = await manager.getSession(session.id);
  const summary = await manager.getSummary(session.id);

  console.log("=== Generation Session ===");
  console.log(JSON.stringify({
    sessionId: finalSession?.id,
    status: finalSession?.status,
    generationArtifactCount: finalSession?.generation.artifacts.length,
    supplementalDraftCount: finalSession?.supplementalArtifactDrafts.length,
  }, null, 2));

  console.log("\n=== Session Summary ===");
  console.log(JSON.stringify(summary, null, 2));

  console.log("\n=== Artifact Decisions ===");
  console.log(JSON.stringify({
    artifactDecisions: finalSession?.artifactDecisions ?? [],
  }, null, 2));

  console.log("\n=== Coverage Gap Decisions ===");
  console.log(JSON.stringify({
    coverageGapDecisions: finalSession?.coverageGapDecisions ?? [],
  }, null, 2));

  console.log("\n=== Supplemental Artifact Drafts ===");
  console.log(JSON.stringify({
    supplementalArtifactDrafts: finalSession?.supplementalArtifactDrafts ?? [],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
