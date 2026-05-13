import {
  detectKnownSkills,
  skillIdFor,
  stableId,
} from "../../knowledge/keywordUtils.js";
import type { Skill } from "../../knowledge/types.js";
import type { SkillRepository, JDRequirementRepository } from "../../knowledge/repositories.js";
import type {
  JDRequirementExtractor,
  ExtractJDRequirementsInput,
  ExtractJDRequirementsResult,
} from "./JDRequirementExtractor.js";

export class DeterministicJDRequirementExtractor implements JDRequirementExtractor {
  constructor(
    private readonly skillRepo: SkillRepository,
    private readonly requirementRepo: JDRequirementRepository,
  ) {}

  async extract(input: ExtractJDRequirementsInput): Promise<ExtractJDRequirementsResult> {
    const now = new Date().toISOString();
    const jdId = stableId("jd", `${input.userId}:${input.targetRole}:${input.jdText}`);
    const detectedSkills = detectKnownSkills(input.jdText);
    const requiredSkillIds: string[] = [];

    for (const detected of detectedSkills) {
      const existing = await this.skillRepo.findByName(input.userId, detected.name);
      if (existing) {
        requiredSkillIds.push(existing.id);
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
      requiredSkillIds.push(skill.id);
    }

    const requirement = {
      id: stableId("req", `${jdId}:core`),
      userId: input.userId,
      jdId,
      description: input.jdText,
      requiredSkillIds,
      weight: 1,
      createdAt: now,
    };
    await this.requirementRepo.save(requirement);

    return { jdId, requirements: [requirement] };
  }
}
