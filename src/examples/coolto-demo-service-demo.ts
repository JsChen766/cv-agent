import { createInMemoryCooltoDemoService } from "../application/CooltoDemoService.js";
import { toExperienceListItem } from "../application/mappers/index.js";

async function main() {
  const service = createInMemoryCooltoDemoService();
  const result = await service.run({
    userId: "user-demo",
    rawExperienceText: [
      "As a Senior Frontend Engineer at Acme Corp, I led a design system project for 12 product teams.",
      "Built React and TypeScript component library with accessibility standards and shared API integration patterns.",
      "Reduced bundle size by 40% through tree-shaking and lazy loading.",
      "Mentored 4 engineers on performance and WCAG practices.",
    ].join("\n"),
    jdText:
      "We need a senior frontend engineer with React, TypeScript, design system, accessibility, API integration, performance optimization, and cross-team collaboration experience.",
    targetRole: "Senior Frontend Engineer",
  });

  const listItem = toExperienceListItem({
    experience: result.ingest.experience,
    skills: result.ingest.skills,
    evidences: result.ingest.evidences,
  });

  console.log("=== Ingest Experience List Item ===\n");
  console.log(JSON.stringify(listItem, null, 2));
  console.log("\n=== Generated Artifacts Count ===\n");
  console.log(result.generation.artifacts.length);
  console.log("\n=== Artifact Bundles ===\n");

  for (const bundle of result.generation.artifacts) {
    console.log(
      JSON.stringify(
        {
          content: bundle.artifact.content,
          riskLevel: bundle.evidenceChain.risk.level,
          evidenceChainSummary: bundle.evidenceChain.summary,
          graphNodesCount: bundle.graphView.nodes.length,
        },
        null,
        2,
      ),
    );
  }

  console.log("\n=== Coverage Report ===\n");
  console.log(JSON.stringify({
    summary: result.generation.coverageReport.summary,
    coveredRequirementIds: result.generation.coverageReport.coveredRequirementIds,
    weaklyCoveredRequirementIds: result.generation.coverageReport.weaklyCoveredRequirementIds,
    evidenceAvailableButNotUsedRequirementIds: result.generation.coverageReport.evidenceAvailableButNotUsedRequirementIds,
    noEvidenceRequirementIds: result.generation.coverageReport.noEvidenceRequirementIds,
  }, null, 2));

  console.log("\n=== Coverage Gap Report ===\n");
  console.log(JSON.stringify({
    summary: result.generation.coverageGapReport.summary,
    supplementalArtifactCount: result.generation.coverageGapReport.supplementalArtifactCount,
    evidenceRequestCount: result.generation.coverageGapReport.evidenceRequestCount,
  }, null, 2));

  console.log("\n=== Coverage Gap Items ===\n");
  for (const item of result.generation.coverageGapReport.items) {
    console.log(JSON.stringify({
      requirementId: item.requirement.id,
      description: item.requirement.description,
      gapType: item.gapType,
      severity: item.severity,
      existingEvidenceIds: item.existingEvidenceIds,
      existingArtifactIds: item.existingArtifactIds,
      supplementalArtifactSuggestions: item.supplementalArtifactSuggestions,
      evidenceRequestSuggestions: item.evidenceRequestSuggestions,
      reason: item.reason,
    }, null, 2));
  }

  const artifactIds = new Set(
    result.generation.artifacts.map((bundle) => bundle.artifact.id),
  );
  for (const item of result.generation.critiqueReport.items) {
    if (!item.artifactId) {
      throw new Error("Demo invariant failed: critique item is missing artifactId.");
    }
    if (!artifactIds.has(item.artifactId)) {
      throw new Error(
        `Demo invariant failed: critique item references unknown artifactId ${item.artifactId}.`,
      );
    }
  }

  console.log("\n=== Critique Report ===\n");
  console.log(JSON.stringify({
    summary: result.generation.critiqueReport.summary,
    items: result.generation.critiqueReport.items.map((item) => ({
      artifactId: item.artifactId,
      verdict: item.verdict,
      truthfulnessRisk: item.truthfulnessRisk,
      exaggerationRisk: item.exaggerationRisk,
      specificityScore: item.specificityScore,
      evidenceStrengthScore: item.evidenceStrengthScore,
      unsupportedClaims: item.unsupportedClaims,
      missingEvidence: item.missingEvidence,
      rewriteSuggestions: item.rewriteSuggestions,
    })),
  }, null, 2));
}

main().catch(console.error);
