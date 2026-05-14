import { createInMemoryCooltoDemoService } from "../application/CooltoDemoService.js";
import {
  GenerationSessionManager,
  InMemoryGenerationSessionRepository,
} from "../application/sessions/index.js";
import { addForcedSupplementalGapForDemo } from "./utils/sessionDemoForcedGap.js";

async function main() {
  const service = createInMemoryCooltoDemoService();
  const result = await service.run({
    userId: "session-forced-gap-demo-user",
    rawExperienceText: [
      "As a Senior Frontend Engineer at Acme Corp, I led a React and TypeScript design system project for 12 product teams.",
      "Built an accessible component library with WCAG practices and shared API integration patterns.",
      "Reduced bundle size by 40% through performance optimization, tree-shaking, and lazy loading.",
    ].join("\n"),
    jdText:
      "We need a senior frontend engineer with React, TypeScript, design system, accessibility, API integration, and performance optimization experience.",
    targetRole: "Senior Frontend Engineer",
  });

  const generation = addForcedSupplementalGapForDemo(result.generation);
  const repo = new InMemoryGenerationSessionRepository();
  const manager = new GenerationSessionManager(repo);
  const session = await manager.createSession({ generation });
  const gap = generation.coverageGapReport.items.find(
    (item) => item.requirement.id === "req-session-demo-api-gap",
  );

  if (gap) {
    await manager.decideCoverageGap({
      sessionId: session.id,
      requirementId: gap.requirement.id,
      decision: "generate_supplemental_artifact",
    });
    await manager.generateSupplementalArtifactDraft({
      sessionId: session.id,
      requirementId: gap.requirement.id,
    });
  }

  const finalSession = await manager.getSession(session.id);
  const summary = await manager.getSummary(session.id);

  console.log("=== Forced Gap Generation Session ===");
  console.log(JSON.stringify({
    sessionId: finalSession?.id,
    forcedGapAdded: true,
    generationArtifactCount: finalSession?.generation.artifacts.length,
    supplementalDraftCount: finalSession?.supplementalArtifactDrafts.length,
  }, null, 2));

  console.log("\n=== Session Summary ===");
  console.log(JSON.stringify(summary, null, 2));

  console.log("\n=== Coverage Gap Decisions ===");
  console.log(JSON.stringify(finalSession?.coverageGapDecisions, null, 2));

  console.log("\n=== Supplemental Artifact Drafts ===");
  console.log(JSON.stringify(finalSession?.supplementalArtifactDrafts, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
