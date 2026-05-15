import { describe, expect, it } from "vitest";
import {
  ExperienceIngestionService,
  InMemoryEvidenceRepository,
  InMemoryExperienceRepository,
  InMemorySkillRepository,
  type ExperienceExtractor,
} from "../src/knowledge/index.js";

describe("ExperienceIngestionService", () => {
  it("turns raw text into experience, evidence, and skills", async () => {
    const experienceRepo = new InMemoryExperienceRepository();
    const evidenceRepo = new InMemoryEvidenceRepository();
    const skillRepo = new InMemorySkillRepository();
    const service = new ExperienceIngestionService(
      experienceRepo,
      evidenceRepo,
      skillRepo,
    );

    const result = await service.ingest({
      userId: "user-1",
      rawText: [
        "As a Frontend Engineer at Acme Corp, I built a React design system.",
        "Reduced bundle size by 40% with lazy loading.",
        "Improved accessibility with WCAG patterns.",
      ].join("\n"),
    });

    expect(result.experience.userId).toBe("user-1");
    expect(result.experience.organization).toBe("Acme Corp");
    expect(result.evidences).toHaveLength(3);
    expect(result.evidences.map((evidence) => evidence.evidenceType)).toEqual([
      "action",
      "result",
      "result",
    ]);
    expect(result.experience.star.situation).toContain("Frontend Engineer");
    expect(result.experience.star.result).toBe("Reduced bundle size by 40% with lazy loading.");
    expect(result.experience.star.result).not.toContain("As a Frontend Engineer");
    expect(result.skills.map((skill) => skill.name)).toEqual(
      expect.arrayContaining(["React", "Performance Optimization", "Accessibility"]),
    );
    await expect(experienceRepo.listByUserId("user-1")).resolves.toHaveLength(1);
    await expect(evidenceRepo.listByUserId("user-1")).resolves.toHaveLength(3);
    await expect(skillRepo.listByUserId("user-1")).resolves.toHaveLength(
      result.skills.length,
    );
  });

  it("classifies scope evidence and keeps result focused on outcome evidence", async () => {
    const service = new ExperienceIngestionService(
      new InMemoryExperienceRepository(),
      new InMemoryEvidenceRepository(),
      new InMemorySkillRepository(),
    );

    const result = await service.ingest({
      userId: "user-1",
      rawText: [
        "As a Senior Frontend Engineer at Acme Corp, I led a React and TypeScript design system project for 12 product teams.",
        "Built an accessible component library with WCAG practices.",
        "Reduced bundle size by 40% through tree-shaking.",
      ].join("\n"),
    });

    expect(result.evidences[0].evidenceType).toBe("scope");
    expect(result.evidences[1].evidenceType).toBe("action");
    expect(result.evidences[2].evidenceType).toBe("result");
    expect(result.experience.star.situation).toContain("12 product teams");
    expect(result.experience.star.task).not.toBe(result.experience.star.situation);
    expect(result.experience.star.task).toBe(
      "Build an accessible component library and support the related design system work.",
    );
    expect(result.experience.star.result).toBe("Reduced bundle size by 40% through tree-shaking.");
  });

  it("builds STAR fields with a single evidence fallback", async () => {
    const service = new ExperienceIngestionService(
      new InMemoryExperienceRepository(),
      new InMemoryEvidenceRepository(),
      new InMemorySkillRepository(),
    );

    const result = await service.ingest({
      userId: "user-1",
      rawText: "Built a React component library.",
    });

    expect(result.evidences).toHaveLength(1);
    expect(result.experience.star.situation).toBeTruthy();
    expect(result.experience.star.task).toBeTruthy();
    expect(result.experience.star.action).toBeTruthy();
    expect(result.experience.star.result).toBeTruthy();
    expect(result.experience.star.task).toBe("Build a React component library.");
  });

  it("preserves sourceDocumentId on generated experience and evidence", async () => {
    const service = new ExperienceIngestionService(
      new InMemoryExperienceRepository(),
      new InMemoryEvidenceRepository(),
      new InMemorySkillRepository(),
    );

    const result = await service.ingest({
      userId: "user-1",
      rawText: "Built a React component library.",
      sourceDocumentId: "doc-1",
    });

    expect(result.experience.sourceDocumentId).toBe("doc-1");
    expect(result.experience.metadata?.sourceDocumentId).toBe("doc-1");
    expect(result.experience.metadata?.ingestion).toBeDefined();
    expect(result.evidences[0].sourceDocumentId).toBe("doc-1");
    expect(result.evidences[0].metadata?.sourceDocumentId).toBe("doc-1");
    expect(result.evidences[0].metadata?.chunk).toBeDefined();
  });

  it("enriches metadata with document and chunk info when documentMetadata is passed", async () => {
    const service = new ExperienceIngestionService(
      new InMemoryExperienceRepository(),
      new InMemoryEvidenceRepository(),
      new InMemorySkillRepository(),
    );

    const result = await service.ingest({
      userId: "user-1",
      rawText: "Built a React component library.",
      sourceDocumentId: "doc-1",
      sourceRef: "upload:resume.md",
      sourceType: "resume",
      documentMetadata: {
        documentId: "doc-1",
        fileName: "resume.md",
        sourceType: "markdown",
        sourceRef: "upload:resume.md",
        parser: "markdown",
        textLength: 33,
      },
    });

    // experience metadata
    expect(result.experience.sourceDocumentId).toBe("doc-1");
    expect(result.experience.metadata?.sourceDocumentId).toBe("doc-1");
    expect(result.experience.metadata?.sourceRef).toBe("upload:resume.md");
    expect(result.experience.metadata?.sourceType).toBe("resume");
    expect((result.experience.metadata?.document as Record<string, unknown>)?.fileName).toBe("resume.md");
    expect((result.experience.metadata?.document as Record<string, unknown>)?.parser).toBe("markdown");
    expect(result.experience.metadata?.ingestion).toBeDefined();

    // evidence metadata
    const evidence = result.evidences[0];
    expect(evidence.sourceDocumentId).toBe("doc-1");
    expect(evidence.metadata?.sourceDocumentId).toBe("doc-1");
    expect((evidence.metadata?.chunk as Record<string, unknown>)?.evidenceIndex).toBe(0);
    expect((evidence.metadata?.chunk as Record<string, unknown>)?.excerptLength).toBeGreaterThan(0);
    expect((evidence.metadata?.document as Record<string, unknown>)?.parser).toBe("markdown");
  });

  it("completes omitted WCAG and API evidence from raw text", async () => {
    const extractor: ExperienceExtractor = {
      async extract() {
        return {
          experiences: [
            {
              type: "work",
              organization: "Acme Corp",
              role: "Senior Frontend Engineer",
              summary: "Led a React and TypeScript design system for 12 product teams and reduced bundle size by 40%.",
              evidenceExcerpts: [
                "As a Senior Frontend Engineer at Acme Corp, I led a React and TypeScript design system project for 12 product teams.",
                "Reduced bundle size by 40% through performance optimization, tree-shaking, and lazy loading.",
              ],
            },
          ],
          warnings: [],
        };
      },
    };
    const service = new ExperienceIngestionService(
      new InMemoryExperienceRepository(),
      new InMemoryEvidenceRepository(),
      new InMemorySkillRepository(),
      extractor,
    );

    const result = await service.ingest({
      userId: "user-1",
      rawText: [
        "As a Senior Frontend Engineer at Acme Corp, I led a React and TypeScript design system project for 12 product teams.",
        "Built an accessible component library with WCAG practices and shared API integration patterns.",
        "Reduced bundle size by 40% through performance optimization, tree-shaking, and lazy loading.",
      ].join("\n"),
    });

    expect(result.evidences).toHaveLength(3);
    expect(result.evidences.map((evidence) => evidence.excerpt)).toContain(
      "Built an accessible component library with WCAG practices and shared API integration patterns.",
    );
    expect(result.skills.find((skill) => skill.name === "Accessibility")?.evidenceIds.length).toBeGreaterThan(0);
    expect(result.skills.find((skill) => skill.name === "API Integration")?.evidenceIds.length).toBeGreaterThan(0);
    expect(result.skills.find((skill) => skill.name === "Design System")?.evidenceIds.length).toBeGreaterThan(0);
    expect(result.experience.star.result).toBe(
      "Reduced bundle size by 40% through performance optimization, tree-shaking, and lazy loading.",
    );
    expect(result.experience.star.task).not.toBe(result.experience.star.situation);
  });

  it("saves output from an injected extractor", async () => {
    const extractor: ExperienceExtractor = {
      async extract() {
        return {
          experiences: [
            {
              type: "project",
              organization: "Demo Org",
              role: "Builder",
              summary: "Built an analytics dashboard.",
              evidenceExcerpts: ["Built an analytics dashboard with PostgreSQL."],
              skillNames: [{ name: "PostgreSQL", category: "technical" }],
              warnings: ["fake extractor warning"],
              metadata: {
                llm: {
                  provider: "fake",
                },
              },
            },
          ],
          warnings: ["fake extractor warning"],
          metadata: {
            llm: {
              provider: "fake",
            },
          },
        };
      },
    };
    const experienceRepo = new InMemoryExperienceRepository();
    const evidenceRepo = new InMemoryEvidenceRepository();
    const skillRepo = new InMemorySkillRepository();
    const service = new ExperienceIngestionService(
      experienceRepo,
      evidenceRepo,
      skillRepo,
      extractor,
    );

    const result = await service.ingest({
      userId: "user-1",
      rawText: "source text",
    });

    expect(result.experience.organization).toBe("Demo Org");
    expect(result.experiences).toHaveLength(1);
    expect(result.skills.map((skill) => skill.name)).toContain("PostgreSQL");
    expect(result.warnings).toEqual(["fake extractor warning"]);
    await expect(experienceRepo.listByUserId("user-1")).resolves.toHaveLength(1);
    await expect(evidenceRepo.listByUserId("user-1")).resolves.toHaveLength(1);
    await expect(skillRepo.listByUserId("user-1")).resolves.toHaveLength(1);
  });

  it("ingests multiple extracted experiences with distinct evidence and merged skills", async () => {
    const extractor: ExperienceExtractor = {
      async extract() {
        return {
          experiences: [
            {
              type: "project",
              organization: "Acme Corp",
              role: "Frontend Engineer",
              summary: "Built a React analytics dashboard.",
              evidenceExcerpts: ["Built a React analytics dashboard for product teams."],
              skillNames: [{ name: "React", category: "technical" }],
              metadata: { extractorExperience: "dashboard" },
            },
            {
              type: "project",
              organization: "Acme Corp",
              role: "Data Engineer",
              summary: "Automated PostgreSQL reporting.",
              evidenceExcerpts: ["Automated PostgreSQL reporting with React status views."],
              skillNames: [
                { name: "PostgreSQL", category: "technical" },
                { name: "React", category: "technical" },
              ],
              metadata: { extractorExperience: "reporting" },
            },
          ],
          warnings: ["extractor-level warning"],
          metadata: { batchId: "batch-1" },
        };
      },
    };
    const experienceRepo = new InMemoryExperienceRepository();
    const evidenceRepo = new InMemoryEvidenceRepository();
    const skillRepo = new InMemorySkillRepository();
    const service = new ExperienceIngestionService(
      experienceRepo,
      evidenceRepo,
      skillRepo,
      extractor,
    );

    const result = await service.ingest({
      userId: "user-1",
      rawText: "Dashboard work.\nReporting work.",
      sourceDocumentId: "doc-1",
      sourceRef: "upload:resume.md",
      sourceType: "resume",
    });

    expect(result.experiences).toHaveLength(2);
    expect(result.experience).toBe(result.experiences[0]);
    expect(new Set(result.experiences.map((experience) => experience.id)).size).toBe(2);
    expect(result.evidences).toHaveLength(2);
    expect(result.evidences[0]?.experienceId).toBe(result.experiences[0]?.id);
    expect(result.evidences[1]?.experienceId).toBe(result.experiences[1]?.id);
    expect(result.evidences[0]?.id).not.toBe(result.evidences[1]?.id);
    expect(result.experiences[0]?.metadata?.ingestion).toMatchObject({
      experienceIndex: 0,
      totalExtractedExperiences: 2,
    });
    expect(result.experiences[1]?.metadata?.ingestion).toMatchObject({
      experienceIndex: 1,
      totalExtractedExperiences: 2,
    });
    expect(result.evidences[0]?.metadata?.ingestion).toMatchObject({
      experienceIndex: 0,
      totalExtractedExperiences: 2,
    });
    expect(result.evidences[1]?.metadata?.ingestion).toMatchObject({
      experienceIndex: 1,
      totalExtractedExperiences: 2,
    });
    expect(result.evidences[0]?.metadata?.chunk).toMatchObject({ evidenceIndex: 0 });
    expect(result.skills.map((skill) => skill.name).sort()).toEqual(["PostgreSQL", "React"]);
    expect(result.skills.find((skill) => skill.name === "React")?.evidenceIds).toEqual(
      expect.arrayContaining([
        result.evidences[0]?.id,
        result.evidences[1]?.id,
      ]),
    );
    expect(result.warnings).toEqual(["extractor-level warning"]);
    await expect(experienceRepo.listByUserId("user-1")).resolves.toHaveLength(2);
    await expect(evidenceRepo.listByUserId("user-1")).resolves.toHaveLength(2);
    await expect(skillRepo.listByUserId("user-1")).resolves.toHaveLength(2);
  });
});
