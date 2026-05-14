import { ArchitectAgent } from "../agents/ArchitectAgent.js";
import { ArchivistAgent } from "../agents/ArchivistAgent.js";
import { StrategistAgent } from "../agents/StrategistAgent.js";
import { createAgentBackedCooltoDemoService } from "../application/factories/createAgentBackedCooltoDemoService.js";
import { createDemoModelClient } from "./utils/createDemoModelClient.js";

async function main() {
  const { modelClient, config } = createDemoModelClient();
  const service = createAgentBackedCooltoDemoService({
    archivistAgent: new ArchivistAgent({ modelClient }),
    strategistAgent: new StrategistAgent({ modelClient }),
    architectAgent: new ArchitectAgent({ modelClient }),
  });

  const rawExperienceText = [
    "As a Senior Frontend Engineer at Acme Corp, I led a React and TypeScript design system project for 12 product teams.",
    "Built an accessible component library with WCAG practices and shared API integration patterns.",
    "Reduced bundle size by 40% through performance optimization, tree-shaking, and lazy loading.",
  ].join("\n");

  const jdText = [
    "We need a senior frontend engineer with React and TypeScript experience.",
    "The role owns design system architecture, accessibility, API integration, and frontend performance.",
    "Candidates should show measurable product impact and strong cross-team collaboration.",
  ].join("\n");

  const result = await service.run({
    userId: "demo-user",
    rawExperienceText,
    jdText,
    targetRole: "Senior Frontend Engineer",
  });

  console.log("=== Provider / Model ===");
  console.log(JSON.stringify(config, null, 2));
  console.log("\n=== Ingest Experience ===");
  console.log(JSON.stringify(result.ingest.experience, null, 2));
  console.log("\n=== Evidence Count ===");
  console.log(result.ingest.evidences.length);
  console.log("\n=== Skills ===");
  console.log(JSON.stringify(result.ingest.skills, null, 2));
  console.log("\n=== Requirements ===");
  console.log(JSON.stringify(result.generation.requirements, null, 2));
  console.log("\n=== Artifact Count ===");
  console.log(result.generation.artifacts.length);
  console.log("\n=== Artifact Bundles ===");

  for (const bundle of result.generation.artifacts) {
    console.log(
      JSON.stringify(
        {
          content: bundle.artifact.content,
          status: bundle.artifact.status,
          scores: bundle.artifact.scores,
          evidenceChainSummary: bundle.evidenceChain.summary,
          riskLevel: bundle.evidenceChain.risk.level,
          graphNodesCount: bundle.graphView.nodes.length,
          graphEdgesCount: bundle.graphView.edges.length,
        },
        null,
        2,
      ),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
