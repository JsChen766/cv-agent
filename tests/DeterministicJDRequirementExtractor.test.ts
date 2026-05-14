import { describe, expect, it } from "vitest";
import { DeterministicJDRequirementExtractor } from "../src/application/extractors/DeterministicJDRequirementExtractor.js";
import { InMemoryJDRequirementRepository, InMemorySkillRepository } from "../src/knowledge/index.js";

describe("DeterministicJDRequirementExtractor", () => {
  it("extracts multiple requirements from a realistic frontend JD text", async () => {
    const skillRepo = new InMemorySkillRepository();
    const requirementRepo = new InMemoryJDRequirementRepository();
    const extractor = new DeterministicJDRequirementExtractor(skillRepo, requirementRepo);

    const result = await extractor.extract({
      userId: "user-1",
      jdText:
        "We need a senior frontend engineer with React, TypeScript, design system, accessibility, API integration, performance optimization, and cross-team collaboration experience.",
      targetRole: "Senior Frontend Engineer",
    });

    expect(result.jdId).toContain("jd-");
    expect(result.requirements.length).toBeGreaterThanOrEqual(5);
    expect(result.requirements.every((requirement) => requirement.userId === "user-1")).toBe(true);

    const savedReqs = await requirementRepo.listByUserId("user-1");
    expect(savedReqs).toHaveLength(result.requirements.length);
  });

  it("maps deterministic requirements to matching skill ids", async () => {
    const skillRepo = new InMemorySkillRepository();
    const requirementRepo = new InMemoryJDRequirementRepository();
    const extractor = new DeterministicJDRequirementExtractor(skillRepo, requirementRepo);

    const result = await extractor.extract({
      userId: "user-skill-map",
      jdText:
        "We need React, TypeScript, design system, accessibility, API integration, performance optimization, and cross-team collaboration experience.",
      targetRole: "Senior Frontend Engineer",
    });
    const skills = await skillRepo.listByUserId("user-skill-map");
    const skillIdByName = new Map(skills.map((skill) => [skill.name, skill.id]));
    const requirementByDescription = new Map(
      result.requirements.map((requirement) => [requirement.description, requirement]),
    );

    expect(requirementByDescription.get("Expert-level React and TypeScript frontend development")?.requiredSkillIds)
      .toEqual(expect.arrayContaining([
        skillIdByName.get("React"),
        skillIdByName.get("TypeScript"),
      ]));
    expect(requirementByDescription.get("Experience building or evolving design system architecture")?.requiredSkillIds)
      .toEqual([skillIdByName.get("Design System")]);
    expect(requirementByDescription.get("Accessibility implementation using WCAG or inclusive design practices")?.requiredSkillIds)
      .toEqual([skillIdByName.get("Accessibility")]);
    expect(requirementByDescription.get("API integration and frontend data-flow management")?.requiredSkillIds)
      .toEqual([skillIdByName.get("API Integration")]);
    expect(requirementByDescription.get("Frontend performance optimization with measurable impact")?.requiredSkillIds)
      .toEqual([skillIdByName.get("Performance Optimization")]);
    expect(requirementByDescription.get("Cross-team collaboration and communication skills")?.requiredSkillIds)
      .toEqual([]);
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
    expect(saved!.description).toBe("Accessibility implementation using WCAG or inclusive design practices");
  });
});
