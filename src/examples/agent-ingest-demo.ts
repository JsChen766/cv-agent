import { ArchivistAgent } from "../agents/ArchivistAgent.js";
import { createAgentBackedExperienceIngestionService } from "../application/factories/createAgentBackedExperienceIngestionService.js";
import {
  InMemoryEvidenceRepository,
  InMemoryExperienceRepository,
  InMemorySkillRepository,
} from "../knowledge/index.js";
import { createDemoModelClient } from "./utils/createDemoModelClient.js";

async function main() {
  const { modelClient, config } = createDemoModelClient();
  const archivistAgent = new ArchivistAgent({ modelClient });

  const experienceRepo = new InMemoryExperienceRepository();
  const evidenceRepo = new InMemoryEvidenceRepository();
  const skillRepo = new InMemorySkillRepository();

  const ingestionService = createAgentBackedExperienceIngestionService({
    archivistAgent,
    experienceRepo,
    evidenceRepo,
    skillRepo,
  });

  const rawText = [
    "As a Senior Frontend Engineer at Acme Corp, I led a React and TypeScript design system project for 12 product teams.",
    "Built an accessible component library with WCAG practices and shared API integration patterns.",
    "Reduced bundle size by 40% through performance optimization, tree-shaking, and lazy loading.",
  ].join("\n");

  const result = await ingestionService.ingest({
    userId: "demo-user",
    rawText,
    sourceRef: "agent-ingest-demo",
    sourceType: "raw_input",
  });

  console.log("=== Provider / Model ===");
  console.log(JSON.stringify(config, null, 2));
  console.log("\n=== Raw Experience Text ===");
  console.log(rawText);
  console.log("\n=== Extracted Experience ===");
  console.log(JSON.stringify(result.experience, null, 2));
  console.log("\n=== Evidences ===");
  console.log(JSON.stringify(result.evidences, null, 2));
  console.log("\n=== Skills ===");
  console.log(JSON.stringify(result.skills, null, 2));
  console.log("\nValidation succeeded: Agent-backed experience ingestion completed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
