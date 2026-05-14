import { describe, expect, it } from "vitest";
import {
  ExperienceIngestionService,
  InMemoryEvidenceRepository,
  InMemoryExperienceRepository,
  InMemorySkillRepository,
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
});
