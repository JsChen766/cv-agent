import { ResumeGenerationService } from "../application/ResumeGenerationService.js";
import { DeterministicJDRequirementExtractor } from "../application/extractors/DeterministicJDRequirementExtractor.js";
import { DeterministicArtifactGenerator } from "../application/generators/DeterministicArtifactGenerator.js";
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
  const requirementExtractor = new DeterministicJDRequirementExtractor(
    skillRepo,
    requirementRepo,
  );
  const artifactGenerator = new DeterministicArtifactGenerator();
  const resumeGeneration = new ResumeGenerationService(
    requirementExtractor,
    artifactGenerator,
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
  console.log("\n=== Retrieved Experiences ===\n");
  for (const retrieved of generationResult.retrievedExperiences) {
    console.log(
      JSON.stringify(
        {
          experienceId: retrieved.experience.id,
          evidences: retrieved.evidences.length,
          skills: retrieved.skills.map((skill) => skill.name),
          matchedEvidences: retrieved.matchedEvidences.length,
          matchedSkills: retrieved.matchedSkills.map((skill) => skill.name),
          reason: retrieved.reason,
        },
        null,
        2,
      ),
    );
  }
  console.log("\n=== Generated Artifacts ===\n");
  generationResult.artifacts.forEach((artifact, index) => {
    console.log(`--- Artifact ${index + 1} ---`);
    console.log(JSON.stringify(artifact, null, 2));
    console.log("Evidence Chain:");
    console.log(JSON.stringify(generationResult.evidenceChains[index], null, 2));
    console.log("Graph View:");
    console.log(JSON.stringify(generationResult.graphViews[index], null, 2));
  });
  console.log("\n=== Coverage Report ===\n");
  console.log(JSON.stringify(generationResult.coverageReport, null, 2));
  console.log("\n=== Coverage Gap Report ===\n");
  console.log(JSON.stringify(generationResult.coverageGapReport, null, 2));
  console.log("\n=== Critique Report ===\n");
  console.log(JSON.stringify(generationResult.critiqueReport, null, 2));
}

main().catch(console.error);
