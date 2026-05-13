import { describe, expect, it } from "vitest";
import { ResumeGenerationService } from "../src/application/ResumeGenerationService.js";
import {
  ExperienceIngestionService,
  InMemoryEvidenceRepository,
  InMemoryExperienceRepository,
  InMemoryGeneratedArtifactRepository,
  InMemoryJDRequirementRepository,
  InMemorySkillRepository,
  KeywordExperienceRetriever,
} from "../src/knowledge/index.js";

describe("ResumeGenerationService", () => {
  it("generates an artifact, evidence chain, and graph view from stored experience", async () => {
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
        "As a Senior Frontend Engineer at Acme Corp, I led a React design system project.",
        "Built TypeScript components with accessibility standards.",
        "Reduced bundle size by 40% with performance optimization.",
      ].join("\n"),
    });

    const retriever = new KeywordExperienceRetriever(
      experienceRepo,
      evidenceRepo,
      skillRepo,
    );
    const service = new ResumeGenerationService(
      experienceRepo,
      evidenceRepo,
      skillRepo,
      requirementRepo,
      artifactRepo,
      retriever,
    );

    const result = await service.generate({
      userId: "user-1",
      jdText:
        "Looking for React, TypeScript, performance optimization, accessibility, and design system experience.",
      targetRole: "Senior Frontend Engineer",
    });

    expect(result.artifact.status).toBe("ready");
    expect(result.artifact.sourceExperienceIds).toHaveLength(1);
    expect(result.artifact.sourceEvidenceIds.length).toBeGreaterThan(0);
    expect(result.evidenceChain.risk.level).toBe("low");
    expect(result.graphView.nodes.some((node) => node.type === "artifact")).toBe(true);
    expect(result.graphView.nodes.some((node) => node.type === "requirement")).toBe(true);
    await expect(artifactRepo.listByUserId("user-1")).resolves.toHaveLength(1);
  });
});
