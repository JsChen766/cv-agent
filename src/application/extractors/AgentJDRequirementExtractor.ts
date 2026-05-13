import { z } from "zod";
import type { BaseAgent } from "../../core/agent/BaseAgent.js";
import {
  detectKnownSkills,
  skillIdFor,
  stableId,
} from "../../knowledge/keywordUtils.js";
import type { Skill } from "../../knowledge/types.js";
import type { SkillRepository, JDRequirementRepository } from "../../knowledge/repositories.js";
import { parseWithSchema } from "../../knowledge/schemas/validate.js";
import type {
  JDRequirementExtractor,
  ExtractJDRequirementsInput,
  ExtractJDRequirementsResult,
} from "./JDRequirementExtractor.js";

const AgentJDRequirementItemSchema = z.object({
  description: z.string(),
  weight: z.number().min(0).max(1),
});

const AgentJDRequirementsOutputSchema = z.object({
  requirements: z.array(AgentJDRequirementItemSchema).min(1),
});

export class AgentJDRequirementExtractor implements JDRequirementExtractor {
  constructor(
    private readonly agent: BaseAgent,
    private readonly skillRepo: SkillRepository,
    private readonly requirementRepo: JDRequirementRepository,
  ) {}

  async extract(input: ExtractJDRequirementsInput): Promise<ExtractJDRequirementsResult> {
    const now = new Date().toISOString();
    const jdId = stableId("jd", `${input.userId}:${input.targetRole}:${input.jdText}`);

    const prompt = [
      `Target role: ${input.targetRole}`,
      `Job description: ${input.jdText}`,
    ].join("\n");

    const output = await this.agent.run({
      content: prompt,
      responseFormat: "json",
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(output.content.trim());
    } catch {
      throw new Error(
        `AgentJDRequirementExtractor: agent output is not valid JSON. Got: ${output.content.slice(0, 200)}`,
      );
    }

    const validated = parseWithSchema(
      AgentJDRequirementsOutputSchema,
      parsed,
      "AgentJDRequirementExtractor",
    );

    const requirements = await Promise.all(
      validated.requirements.map(async (item, index) => {
        const requiredSkillIds = await this.resolveSkills(input.userId, item.description, now);

        const requirement = {
          id: stableId("req", `${jdId}:agent-${index}`),
          userId: input.userId,
          jdId,
          description: item.description,
          requiredSkillIds,
          weight: item.weight,
          createdAt: now,
        };
        await this.requirementRepo.save(requirement);
        return requirement;
      }),
    );

    return { jdId, requirements };
  }

  private async resolveSkills(userId: string, text: string, now: string): Promise<string[]> {
    const detected = detectKnownSkills(text);
    const ids: string[] = [];

    for (const detectedSkill of detected) {
      const existing = await this.skillRepo.findByName(userId, detectedSkill.name);
      if (existing) {
        ids.push(existing.id);
        continue;
      }

      const skill: Skill = {
        id: skillIdFor(userId, detectedSkill.name),
        userId,
        name: detectedSkill.name,
        category: detectedSkill.category,
        evidenceIds: [],
        createdAt: now,
        updatedAt: now,
      };
      await this.skillRepo.save(skill);
      ids.push(skill.id);
    }

    return ids;
  }
}
