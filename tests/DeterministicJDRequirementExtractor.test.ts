import { describe, expect, it } from "vitest";
import { DeterministicJDRequirementExtractor } from "../src/application/extractors/DeterministicJDRequirementExtractor.js";
import { InMemoryJDRequirementRepository, InMemorySkillRepository } from "../src/knowledge/index.js";

describe("DeterministicJDRequirementExtractor", () => {
  it("extracts requirements from a JD text", async () => {
    const skillRepo = new InMemorySkillRepository();
    const requirementRepo = new InMemoryJDRequirementRepository();
    const extractor = new DeterministicJDRequirementExtractor(skillRepo, requirementRepo);

    const result = await extractor.extract({
      userId: "user-1",
      jdText: "Looking for React, TypeScript, performance optimization, and design system experience.",
      targetRole: "Senior Frontend Engineer",
    });

    expect(result.jdId).toContain("jd-");
    expect(result.requirements).toHaveLength(1);
    expect(result.requirements[0].userId).toBe("user-1");
    expect(result.requirements[0].requiredSkillIds.length).toBeGreaterThan(0);

    const savedReqs = await requirementRepo.listByUserId("user-1");
    expect(savedReqs).toHaveLength(1);
  });

  it("creates new skills when they do not exist", async () => {
    const skillRepo = new InMemorySkillRepository();
    const requirementRepo = new InMemoryJDRequirementRepository();
    const extractor = new DeterministicJDRequirementExtractor(skillRepo, requirementRepo);

    await extractor.extract({
      userId: "user-2",
      jdText: "React and TypeScript required.",
      targetRole: "Frontend Engineer",
    });

    const skills = await skillRepo.listByUserId("user-2");
    const skillNames = skills.map((s) => s.name);
    expect(skillNames).toEqual(
      expect.arrayContaining(["React", "TypeScript"]),
    );
  });

  it("reuses existing skills", async () => {
    const skillRepo = new InMemorySkillRepository();
    const requirementRepo = new InMemoryJDRequirementRepository();
    const extractor = new DeterministicJDRequirementExtractor(skillRepo, requirementRepo);

    // First extraction creates skills
    await extractor.extract({
      userId: "user-3",
      jdText: "React required.",
      targetRole: "Frontend Engineer",
    });

    const skillsBefore = await skillRepo.listByUserId("user-3");
    const skillCount = skillsBefore.length;

    // Second extraction should reuse
    await extractor.extract({
      userId: "user-3",
      jdText: "React and TypeScript required.",
      targetRole: "Frontend Engineer",
    });

    const skillsAfter = await skillRepo.listByUserId("user-3");
    expect(skillsAfter.length).toBeGreaterThan(skillCount);
  });

  it("saves the requirement to the repository", async () => {
    const skillRepo = new InMemorySkillRepository();
    const requirementRepo = new InMemoryJDRequirementRepository();
    const extractor = new DeterministicJDRequirementExtractor(skillRepo, requirementRepo);

    const result = await extractor.extract({
      userId: "user-4",
      jdText: "Accessibility experience needed.",
      targetRole: "Accessibility Engineer",
    });

    const saved = await requirementRepo.getById(result.requirements[0].id);
    expect(saved).toBeTruthy();
    expect(saved!.description).toBe("Accessibility experience needed.");
  });
});
