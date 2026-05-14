import { describe, expect, it } from "vitest";
import { ResumeGenerationService } from "../src/application/ResumeGenerationService.js";
import { DeterministicJDRequirementExtractor } from "../src/application/extractors/DeterministicJDRequirementExtractor.js";
import { DeterministicArtifactGenerator } from "../src/application/generators/DeterministicArtifactGenerator.js";
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
  it("generates multiple artifacts, evidence chains, and graph views from stored experience", async () => {
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
    await ingestion.ingest({
      userId: "user-1",
      rawText: [
        "As a Frontend Platform Engineer at Beta Inc, I built a React component library.",
        "Improved accessibility coverage with WCAG review patterns.",
        "Added TypeScript testing utilities for reusable UI components.",
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

    const result = await service.generate({
      userId: "user-1",
      jdText:
        "Looking for React, TypeScript, performance optimization, accessibility, and design system experience.",
      targetRole: "Senior Frontend Engineer",
    });

    expect(result.userId).toBe("user-1");
    expect(result.jdText).toContain("React");
    expect(result.targetRole).toBe("Senior Frontend Engineer");
    expect(result.artifacts).toHaveLength(3);
    expect("artifact" in result).toBe(false);
    expect("evidenceChain" in result).toBe(false);
    expect("graphView" in result).toBe(false);
    expect(new Set(result.artifacts.map((artifact) => artifact.id)).size).toBe(3);
    expect(new Set(result.artifacts.map((artifact) => artifact.content)).size).toBe(3);
    expect(result.artifacts[0]?.status).toBe("ready");
    expect(result.artifacts[0]?.sourceExperienceIds).toHaveLength(1);
    expect(result.artifacts[0]?.sourceEvidenceIds.length).toBeGreaterThan(0);
    expect(result.evidenceChains[0]?.requirementMatches[0]?.matchedSkills.length).toBeGreaterThan(0);
    expect(result.evidenceChains[0]?.risk.level).toBe("low");
    expect(result.evidenceChains).toHaveLength(result.artifacts.length);
    expect(result.graphViews).toHaveLength(result.artifacts.length);
    expect(result.coverageReport.totalRequirements).toBe(result.requirements.length);
    expect(result.coverageReport.items.length).toBe(result.requirements.length);
    expect(result.coverageGapReport.items).toBeDefined();
    expect(result.critiqueReport.items).toHaveLength(result.artifacts.length);
    expect(result.graphViews[0]?.nodes.some((node) => node.type === "artifact")).toBe(true);
    expect(result.graphViews[0]?.nodes.some((node) => node.type === "requirement")).toBe(true);
    await expect(artifactRepo.listByUserId("user-1")).resolves.toHaveLength(
      result.artifacts.length,
    );
  });

  it("generates three needs_review artifacts when no experience is retrieved", async () => {
    const experienceRepo = new InMemoryExperienceRepository();
    const evidenceRepo = new InMemoryEvidenceRepository();
    const skillRepo = new InMemorySkillRepository();
    const requirementRepo = new InMemoryJDRequirementRepository();
    const artifactRepo = new InMemoryGeneratedArtifactRepository();
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

    const result = await service.generate({
      userId: "user-empty",
      jdText: "Looking for React and TypeScript experience.",
      targetRole: "Frontend Engineer",
    });

    expect(result.artifacts).toHaveLength(3);
    expect(result.artifacts.every((artifact) => artifact.status === "needs_review")).toBe(true);
    expect(result.artifacts.every((artifact) => artifact.sourceExperienceIds.length === 0)).toBe(true);
    expect(result.artifacts.every((artifact) => artifact.sourceEvidenceIds.length === 0)).toBe(true);
    expect(result.evidenceChains).toHaveLength(3);
    expect(result.graphViews).toHaveLength(3);
    expect(result.coverageReport.weaklyCoveredRequirementIds.length).toBeGreaterThan(0);
    expect(result.coverageGapReport.items.length).toBeGreaterThan(0);
    expect(result.critiqueReport.items.every((item) => item.verdict === "reject")).toBe(true);
    expect(
      result.evidenceChains.every((chain) => chain.risk.missingEvidenceClaims.length > 0),
    ).toBe(true);
  });

  it("does not depend on internal mockStrategist or mockArchitect methods", async () => {
    const service = new ResumeGenerationService(
      new DeterministicJDRequirementExtractor(
        new InMemorySkillRepository(),
        new InMemoryJDRequirementRepository(),
      ),
      new DeterministicArtifactGenerator(),
      new InMemoryExperienceRepository(),
      new InMemoryEvidenceRepository(),
      new InMemorySkillRepository(),
      new InMemoryJDRequirementRepository(),
      new InMemoryGeneratedArtifactRepository(),
      new KeywordExperienceRetriever(
        new InMemoryExperienceRepository(),
        new InMemoryEvidenceRepository(),
        new InMemorySkillRepository(),
      ),
    );

    // Verify the service has no mockStrategist or mockArchitect methods
    expect("mockStrategist" in service).toBe(false);
    expect("mockArchitect" in service).toBe(false);
  });
});
