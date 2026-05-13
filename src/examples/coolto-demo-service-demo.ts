import { createInMemoryCooltoDemoService } from "../application/CooltoDemoService.js";
import { toExperienceListItem } from "../application/mappers/index.js";

async function main() {
  const service = createInMemoryCooltoDemoService();
  const result = await service.run({
    userId: "user-demo",
    rawExperienceText: [
      "As a Senior Frontend Engineer at Acme Corp, I led a design system project for 12 product teams.",
      "Built React and TypeScript component library with accessibility standards.",
      "Reduced bundle size by 40% through tree-shaking and lazy loading.",
      "Mentored 4 engineers on performance and WCAG practices.",
    ].join("\n"),
    jdText:
      "We need a senior frontend engineer with React, TypeScript, performance optimization, accessibility, and design system experience.",
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
}

main().catch(console.error);
