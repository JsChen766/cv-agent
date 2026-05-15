import { describe, expect, it } from "vitest";
import { ResumeGenerationService } from "../src/application/ResumeGenerationService.js";
import type {
  ArtifactCritic,
  ArtifactCritiqueReport,
  CritiqueArtifactsInput,
} from "../src/application/critique/types.js";
import { DeterministicJDRequirementExtractor } from "../src/application/extractors/DeterministicJDRequirementExtractor.js";
import { DeterministicArtifactGenerator } from "../src/application/generators/DeterministicArtifactGenerator.js";
import type {
  ArtifactGenerator,
  GenerateArtifactsInput,
  GenerateArtifactsResult,
} from "../src/application/generators/ArtifactGenerator.js";
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

    const service = new ResumeGenerationService({
      requirementExtractor,
      artifactGenerator,
      experienceRepo,
      evidenceRepo,
      skillRepo,
      requirementRepo,
      artifactRepo,
      retriever,
    });

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
    expect(["low", "medium"]).toContain(result.evidenceChains[0]?.risk.level);
    expect(result.evidenceChains.some((chain) => chain.risk.level === "low")).toBe(true);
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

    const service = new ResumeGenerationService({
      requirementExtractor,
      artifactGenerator,
      experienceRepo,
      evidenceRepo,
      skillRepo,
      requirementRepo,
      artifactRepo,
      retriever,
    });

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
    const service = new ResumeGenerationService({
      requirementExtractor: new DeterministicJDRequirementExtractor(
        new InMemorySkillRepository(),
        new InMemoryJDRequirementRepository(),
      ),
      artifactGenerator: new DeterministicArtifactGenerator(),
      experienceRepo: new InMemoryExperienceRepository(),
      evidenceRepo: new InMemoryEvidenceRepository(),
      skillRepo: new InMemorySkillRepository(),
      requirementRepo: new InMemoryJDRequirementRepository(),
      artifactRepo: new InMemoryGeneratedArtifactRepository(),
      retriever: new KeywordExperienceRetriever(
        new InMemoryExperienceRepository(),
        new InMemoryEvidenceRepository(),
        new InMemorySkillRepository(),
      ),
    });

    // Verify the service has no mockStrategist or mockArchitect methods
    expect("mockStrategist" in service).toBe(false);
    expect("mockArchitect" in service).toBe(false);
  });

  it("preserves needs_confirmation artifact metadata from injected generator", async () => {
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
        "As a BI Developer at Acme Corp, I built Power BI dashboards.",
        "Reduced report preparation time from 2 hours to 20 minutes.",
      ].join("\n"),
    });

    const fakeGenerator: ArtifactGenerator = {
      async generate(input: GenerateArtifactsInput): Promise<GenerateArtifactsResult> {
        const evidence = input.evidences?.[0];
        const experience = input.experiences?.[0];
        if (!evidence || !experience) {
          throw new Error("Expected generator context.");
        }
        const now = "2026-01-01T00:00:00.000Z";
        return {
          artifacts: [{
            id: "artifact-confirmation",
            userId: input.userId,
            type: "resume_bullet",
            content: "Improved reporting efficiency by 80%.",
            sourceExperienceIds: [experience.id],
            sourceEvidenceIds: [evidence.id],
            matchedSkillIds: [],
            targetJDId: input.jdId,
            targetRequirementIds: input.requirements.slice(0, 1).map((requirement) => requirement.id),
            targetRole: input.targetRole,
            scores: {
              overall: 0.55,
              requirementMatch: 0.55,
              evidenceStrength: 0.8,
            },
            status: "needs_review",
            metadata: {
              enhancement: {
                status: "needs_confirmation",
                claims: [{
                  text: "Improved reporting efficiency by 80%.",
                  supportLevel: "needs_user_confirmation",
                  riskLevel: "medium",
                  evidenceIds: [evidence.id],
                  sourceExperienceIds: [experience.id],
                  userConfirmationPrompt: "Can you confirm the 80% improvement?",
                }],
                confirmationQuestions: ["Can you confirm the 80% improvement?"],
                enhancementStrategy: "confirmation_needed",
              },
            },
            createdAt: now,
            updatedAt: now,
          }],
          warnings: [],
        };
      },
    };
    const service = new ResumeGenerationService({
      requirementExtractor: new DeterministicJDRequirementExtractor(skillRepo, requirementRepo),
      artifactGenerator: fakeGenerator,
      experienceRepo,
      evidenceRepo,
      skillRepo,
      requirementRepo,
      artifactRepo,
      retriever: new KeywordExperienceRetriever(experienceRepo, evidenceRepo, skillRepo),
    });

    const result = await service.generate({
      userId: "user-1",
      jdText: "Need Power BI reporting and SQL experience.",
      targetRole: "BI Analyst",
    });

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.metadata?.enhancement).toMatchObject({
      status: "needs_confirmation",
      enhancementStrategy: "confirmation_needed",
    });
    expect(result.evidenceChains).toHaveLength(1);
    expect(result.graphViews).toHaveLength(1);
    await expect(artifactRepo.getById("artifact-confirmation")).resolves.toMatchObject({
      metadata: {
        enhancement: expect.objectContaining({
          status: "needs_confirmation",
        }),
      },
    });
  });

  it("uses an injected ArtifactCritic and preserves optional critique fields", async () => {
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
      rawText: "As a Frontend Engineer at Acme Corp, I built React dashboards.",
    });

    const fakeCritic: ArtifactCritic = {
      async critique(input: CritiqueArtifactsInput): Promise<ArtifactCritiqueReport> {
        const artifact = input.artifacts[0];
        if (!artifact) {
          throw new Error("Expected artifact.");
        }
        return {
          id: "critique-fake",
          userId: input.userId,
          jdId: input.jdId,
          items: [{
            artifactId: artifact.id,
            verdict: "revise",
            truthfulnessRisk: "medium",
            exaggerationRisk: "medium",
            specificityScore: 0.7,
            evidenceStrengthScore: 0.6,
            unsupportedClaims: [],
            missingEvidence: ["Confirm the metric."],
            rewriteSuggestions: ["Remove unconfirmed metric."],
            confirmationQuestions: ["Can you confirm the metric?"],
            safeRewriteSuggestion: "Built React dashboards with cited evidence.",
            claimReviews: [{
              claimText: "Unconfirmed metric.",
              supportLevel: "needs_user_confirmation",
              riskLevel: "medium",
              verdict: "revise",
              reason: "Needs confirmation.",
              evidenceIds: [],
            }],
          }],
          summary: "Fake critic used.",
          createdAt: "2026-01-01T00:00:00.000Z",
        };
      },
    };
    const service = new ResumeGenerationService({
      requirementExtractor: new DeterministicJDRequirementExtractor(skillRepo, requirementRepo),
      artifactGenerator: new DeterministicArtifactGenerator(),
      experienceRepo,
      evidenceRepo,
      skillRepo,
      requirementRepo,
      artifactRepo,
      retriever: new KeywordExperienceRetriever(experienceRepo, evidenceRepo, skillRepo),
      artifactCritic: fakeCritic,
    });

    const result = await service.generate({
      userId: "user-1",
      jdText: "Need React dashboard experience.",
      targetRole: "Frontend Engineer",
    });

    expect(result.critiqueReport.summary).toBe("Fake critic used.");
    expect(result.critiqueReport.items[0]?.confirmationQuestions).toEqual([
      "Can you confirm the metric?",
    ]);
    expect(result.critiqueReport.items[0]?.claimReviews?.[0]).toMatchObject({
      supportLevel: "needs_user_confirmation",
      verdict: "revise",
    });
  });
});
