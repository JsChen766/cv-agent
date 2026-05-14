import {
  detectKnownSkills,
  skillIdFor,
  stableId,
} from "../../knowledge/keywordUtils.js";
import type { JDRequirement, Skill } from "../../knowledge/types.js";
import type { SkillRepository, JDRequirementRepository } from "../../knowledge/repositories.js";
import type {
  JDRequirementExtractor,
  ExtractJDRequirementsInput,
  ExtractJDRequirementsResult,
} from "./JDRequirementExtractor.js";

type RequirementTemplate = {
  slug: string;
  description: string;
  skillNames: string[];
  weight: number;
  shouldInclude: (text: string, skillIdsByName: Map<string, string>) => boolean;
};

const REQUIREMENT_TEMPLATES: RequirementTemplate[] = [
  {
    slug: "react-typescript",
    description: "Expert-level React and TypeScript frontend development",
    skillNames: ["React", "TypeScript"],
    weight: 1,
    shouldInclude: (_text, skills) => skills.has("React") || skills.has("TypeScript"),
  },
  {
    slug: "design-system",
    description: "Experience building or evolving design system architecture",
    skillNames: ["Design System"],
    weight: 0.9,
    shouldInclude: (text, skills) =>
      skills.has("Design System") || /\bdesign system|component library\b/i.test(text),
  },
  {
    slug: "accessibility",
    description: "Accessibility implementation using WCAG or inclusive design practices",
    skillNames: ["Accessibility"],
    weight: 0.85,
    shouldInclude: (text, skills) =>
      skills.has("Accessibility") || /\baccessibility|accessible|wcag|a11y\b/i.test(text),
  },
  {
    slug: "api-integration",
    description: "API integration and frontend data-flow management",
    skillNames: ["API Integration"],
    weight: 0.8,
    shouldInclude: (text, skills) =>
      skills.has("API Integration") || /\bapi|integration|data[- ]?flow\b/i.test(text),
  },
  {
    slug: "performance",
    description: "Frontend performance optimization with measurable impact",
    skillNames: ["Performance Optimization"],
    weight: 0.9,
    shouldInclude: (text, skills) =>
      skills.has("Performance Optimization") || /\bperformance|optimization|bundle\b/i.test(text),
  },
  {
    slug: "collaboration",
    description: "Cross-team collaboration and communication skills",
    skillNames: [],
    weight: 0.65,
    shouldInclude: (text) =>
      /\bcross-team|cross functional|cross-functional|collaboration|communication|stakeholder\b/i
        .test(text),
  },
];

export class DeterministicJDRequirementExtractor implements JDRequirementExtractor {
  constructor(
    private readonly skillRepo: SkillRepository,
    private readonly requirementRepo: JDRequirementRepository,
  ) {}

  async extract(input: ExtractJDRequirementsInput): Promise<ExtractJDRequirementsResult> {
    const now = new Date().toISOString();
    const jdId = stableId("jd", `${input.userId}:${input.targetRole}:${input.jdText}`);
    const skillIdsByName = await this.ensureDetectedSkills(input, now);
    const requirements = this.buildRequirements({
      userId: input.userId,
      jdId,
      jdText: input.jdText,
      skillIdsByName,
      now,
    });

    for (const requirement of requirements) {
      await this.requirementRepo.save(requirement);
    }

    return { jdId, requirements };
  }

  private async ensureDetectedSkills(
    input: ExtractJDRequirementsInput,
    now: string,
  ): Promise<Map<string, string>> {
    const skillIdsByName = new Map<string, string>();
    for (const detected of detectKnownSkills(input.jdText)) {
      const existing = await this.skillRepo.findByName(input.userId, detected.name);
      if (existing) {
        skillIdsByName.set(existing.name, existing.id);
        continue;
      }

      const skill: Skill = {
        id: skillIdFor(input.userId, detected.name),
        userId: input.userId,
        name: detected.name,
        category: detected.category,
        evidenceIds: [],
        createdAt: now,
        updatedAt: now,
      };
      await this.skillRepo.save(skill);
      skillIdsByName.set(skill.name, skill.id);
    }
    return skillIdsByName;
  }

  private buildRequirements(input: {
    userId: string;
    jdId: string;
    jdText: string;
    skillIdsByName: Map<string, string>;
    now: string;
  }): JDRequirement[] {
    const requirements = REQUIREMENT_TEMPLATES
      .filter((template) => template.shouldInclude(input.jdText, input.skillIdsByName))
      .map((template) => ({
        id: stableId("req", `${input.jdId}:${template.slug}`),
        userId: input.userId,
        jdId: input.jdId,
        description: template.description,
        requiredSkillIds: template.skillNames
          .map((name) => input.skillIdsByName.get(name))
          .filter(Boolean) as string[],
        weight: template.weight,
        createdAt: input.now,
      }));

    if (requirements.length > 0) {
      return requirements;
    }

    return [{
      id: stableId("req", `${input.jdId}:core`),
      userId: input.userId,
      jdId: input.jdId,
      description: input.jdText,
      requiredSkillIds: Array.from(input.skillIdsByName.values()),
      weight: 1,
      createdAt: input.now,
    }];
  }
}
