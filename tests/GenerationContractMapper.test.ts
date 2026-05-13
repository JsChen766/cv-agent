import { describe, expect, it } from "vitest";
import { ResumeGenerationService } from "../src/application/ResumeGenerationService.js";
import { DeterministicJDRequirementExtractor } from "../src/application/extractors/DeterministicJDRequirementExtractor.js";
import { DeterministicArtifactGenerator } from "../src/application/generators/DeterministicArtifactGenerator.js";
import { toGenerateResumeResponse } from "../src/application/mappers/index.js";
import {
  ExperienceIngestionService,
  InMemoryEvidenceRepository,
  InMemoryExperienceRepository,
  InMemoryGeneratedArtifactRepository,
  InMemoryJDRequirementRepository,
  InMemorySkillRepository,
  KeywordExperienceRetriever,
} from "../src/knowledge/index.js";

describe("GenerationContractMapper", () => {
  it("maps GenerateResumeResult into frontend artifact bundles by index", async () => {
    const result = await createGenerationResult();
    const response = toGenerateResumeResponse(result);

    expect(response.userId).toBe(result.userId);
    expect(response.artifacts).toHaveLength(result.artifacts.length);
    expect(response.artifacts[0]?.artifact).toBe(result.artifacts[0]);
    expect(response.artifacts[0]?.evidenceChain).toBe(result.evidenceChains[0]);
    expect(response.artifacts[0]?.graphView).toBe(result.graphViews[0]);
  });

  it("throws when artifact, evidence chain, and graph view counts differ", async () => {
    const result = await createGenerationResult();

    expect(() =>
      toGenerateResumeResponse({
        ...result,
        graphViews: result.graphViews.slice(1),
      }),
    ).toThrow(/must have the same length/);
  });
});

async function createGenerationResult() {
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
  await ingestion.ingest({
    userId: "user-1",
    rawText: [
      "As a Frontend Engineer at Acme Corp, I built a React design system.",
      "Reduced bundle size by 40% through performance optimization.",
    ].join("\n"),
  });

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
  const service = new ResumeGenerationService(
    requirementExtractor,
    artifactGenerator,
    experienceRepo,
    evidenceRepo,
    skillRepo,
    requirementRepo,
    artifactRepo,
    retriever,
  );

  return service.generate({
    userId: "user-1",
    jdText: "React performance design system experience.",
    targetRole: "Frontend Engineer",
  });
}
