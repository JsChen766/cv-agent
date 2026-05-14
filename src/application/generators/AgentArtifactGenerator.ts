import { z } from "zod";
import { stableId } from "../../knowledge/keywordUtils.js";
import { GeneratedArtifactTypeSchema } from "../../knowledge/schemas/GeneratedArtifactSchema.js";
import { parseWithSchema } from "../../knowledge/schemas/validate.js";
import type { BaseAgent } from "../../core/agent/BaseAgent.js";
import { parseAgentJson } from "../../core/json/index.js";
import type { GeneratedArtifact } from "../../knowledge/types.js";
import type { ArtifactGenerator, GenerateArtifactsInput } from "./ArtifactGenerator.js";

const AgentArtifactItemSchema = z.object({
  type: GeneratedArtifactTypeSchema,
  content: z.string(),
  sourceExperienceIds: z.array(z.string()),
  sourceEvidenceIds: z.array(z.string()),
  matchedSkillIds: z.array(z.string()),
  targetRequirementIds: z.array(z.string()),
});

const AgentArtifactOutputSchema = z.array(AgentArtifactItemSchema);

const MIN_ARTIFACTS = 3;

export class AgentArtifactGenerator implements ArtifactGenerator {
  constructor(private readonly agent: BaseAgent) {}

  async generate(input: GenerateArtifactsInput): Promise<GeneratedArtifact[]> {
    const now = new Date().toISOString();
    const prompt = this.buildPrompt(input);

    const output = await this.agent.run({
      content: prompt,
      responseFormat: "json",
    });

    const parsed = parseAgentJson(output.content, { expectedRoot: "array" });

    const validated = parseWithSchema(
      AgentArtifactOutputSchema,
      parsed,
      "AgentArtifactGenerator",
    );

    if (validated.length < MIN_ARTIFACTS) {
      throw new Error(
        `AgentArtifactGenerator: expected at least ${MIN_ARTIFACTS} artifacts, got ${validated.length}`,
      );
    }

    const allowedExperienceIds = new Set(input.retrievedExperiences.map((e) => e.experience.id));
    const allowedEvidenceIds = new Set(
      input.retrievedExperiences.flatMap((e) => e.matchedEvidences.map((ev) => ev.id)),
    );
    const allowedSkillIds = new Set(
      input.retrievedExperiences.flatMap((e) => e.matchedSkills.map((s) => s.id)),
    );
    const allowedRequirementIds = new Set(input.requirements.map((r) => r.id));

    return validated.map((item, index) => {
      const sourceEvidenceIds = item.sourceEvidenceIds.filter((id) => allowedEvidenceIds.has(id));
      const sourceExperienceIds = item.sourceExperienceIds.filter((id) => allowedExperienceIds.has(id));
      const matchedSkillIds = item.matchedSkillIds.filter((id) => allowedSkillIds.has(id));
      const targetRequirementIds = item.targetRequirementIds.filter((id) => allowedRequirementIds.has(id));

      const hasEvidence = sourceEvidenceIds.length > 0;
      const evidenceStrength = hasEvidence ? 0.85 : 0.2;
      const score = hasEvidence ? 0.7 : 0.1;

      return {
        id: stableId("artifact", `${input.userId}:${input.jdId}:agent-${index}:${item.content}`),
        userId: input.userId,
        type: item.type,
        content: item.content,
        sourceExperienceIds,
        sourceEvidenceIds,
        matchedSkillIds,
        targetJDId: input.jdId,
        targetRequirementIds,
        targetRole: input.targetRole,
        scores: {
          overall: score,
          requirementMatch: score,
          evidenceStrength,
        },
        status: hasEvidence ? "ready" : "needs_review",
        createdAt: now,
        updatedAt: now,
      };
    });
  }

  private buildPrompt(input: GenerateArtifactsInput): string {
    const requirementLines = input.requirements.map(
      (r) => `- req: ${r.id} | description: ${r.description} | weight: ${r.weight}`,
    );

    const experienceLines = input.retrievedExperiences.map((re) => {
      const exp = re.experience;
      return [
        `  Experience: ${exp.id} | ${exp.role} @ ${exp.organization} | type: ${exp.type}`,
        `    summary: ${exp.summary}`,
        `    evidenceIds: [${re.matchedEvidences.map((e) => `${e.id}:${e.excerpt.slice(0, 60)}`).join(", ")}]`,
        `    skillIds: [${re.matchedSkills.map((s) => s.id).join(", ")}]`,
        `    matchScore: ${re.matchScore}`,
      ].join("\n");
    });

    return [
      `Target role: ${input.targetRole}`,
      `Job description: ${input.jdText}`,
      `Requirements:`,
      ...requirementLines,
      `Retrieved experiences:`,
      experienceLines.length > 0 ? experienceLines.join("\n") : "(none)",
    ].join("\n");
  }
}
