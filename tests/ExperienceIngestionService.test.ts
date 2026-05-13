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
    expect(result.evidences.some((evidence) => evidence.evidenceType === "metric")).toBe(true);
    expect(result.skills.map((skill) => skill.name)).toEqual(
      expect.arrayContaining(["React", "Performance Optimization", "Accessibility"]),
    );
    await expect(experienceRepo.listByUserId("user-1")).resolves.toHaveLength(1);
    await expect(evidenceRepo.listByUserId("user-1")).resolves.toHaveLength(3);
    await expect(skillRepo.listByUserId("user-1")).resolves.toHaveLength(
      result.skills.length,
    );
  });
});
