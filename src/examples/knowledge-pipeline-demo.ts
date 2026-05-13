import { ResumeGenerationService } from "../application/ResumeGenerationService.js";
import {
  ExperienceIngestionService,
  InMemoryEvidenceRepository,
  InMemoryExperienceRepository,
  InMemoryGeneratedArtifactRepository,
  InMemoryJDRequirementRepository,
  InMemorySkillRepository,
  KeywordExperienceRetriever,
} from "../knowledge/index.js";

async function main() {
  const userId = "user-demo";
  const experienceRepo = new InMemoryExperienceRepository();
  const evidenceRepo = new InMemoryEvidenceRepository();
  const skillRepo = new InMemorySkillRepository();
  const requirementRepo = new InMemoryJDRequirementRepository();
  const artifactRepo = new InMemoryGeneratedArtifactRepository();

  const ingestion = new ExperienceIngestionService(
    experienceRepo,
    evidenceRepo,
    skillRepo,
  );
  const retriever = new KeywordExperienceRetriever(
    experienceRepo,
    evidenceRepo,
    skillRepo,
  );
  const resumeGeneration = new ResumeGenerationService(
    experienceRepo,
    evidenceRepo,
    skillRepo,
    requirementRepo,
    artifactRepo,
    retriever,
  );

  const rawExperience = [
    "As a Senior Frontend Engineer at Acme Corp, I led a design system project for 12 product teams.",
    "Built React and TypeScript component library with accessibility standards.",
    "Reduced bundle size by 40% through tree-shaking and lazy loading.",
    "Mentored 4 engineers on performance and WCAG practices.",
  ].join("\n");

  const ingestResult = await ingestion.ingest({
    userId,
    rawText: rawExperience,
    sourceRef: "demo:raw-experience",
  });

  const jdText =
    "We need a senior frontend engineer with React, TypeScript, performance optimization, accessibility, and design system experience.";

  const generationResult = await resumeGeneration.generate({
    userId,
    jdText,
    targetRole: "Senior Frontend Engineer",
  });

  console.log("=== Ingested Experience Knowledge ===\n");
  console.log(JSON.stringify(ingestResult, null, 2));
  console.log("\n=== Generated Artifact ===\n");
  console.log(JSON.stringify(generationResult.artifact, null, 2));
  console.log("\n=== Evidence Chain ===\n");
  console.log(JSON.stringify(generationResult.evidenceChain, null, 2));
  console.log("\n=== Graph View ===\n");
  console.log(JSON.stringify(generationResult.graphView, null, 2));
}

main().catch(console.error);
