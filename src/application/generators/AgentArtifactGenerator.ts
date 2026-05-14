import { z } from "zod";
import { stableId, tokenize } from "../../knowledge/keywordUtils.js";
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
type AgentArtifactItem = z.infer<typeof AgentArtifactItemSchema>;

const MIN_ARTIFACTS = 3;
const MAX_ALIGNED_EVIDENCE_IDS = 3;

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
      const sourceExperienceIds = item.sourceExperienceIds.filter((id) => allowedExperienceIds.has(id));
      const matchedSkillIds = item.matchedSkillIds.filter((id) => allowedSkillIds.has(id));
      const targetRequirementIds = item.targetRequirementIds.filter((id) => allowedRequirementIds.has(id));
      const alignedItem = {
        ...item,
        sourceExperienceIds,
        matchedSkillIds,
        targetRequirementIds,
      };
      const sourceEvidenceIds = this.alignEvidenceIds({
        item: alignedItem,
        requirements: input.requirements,
        retrievedExperiences: input.retrievedExperiences,
        allowedEvidenceIds,
        allowedSkillIds,
        allowedRequirementIds,
      });

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

  private alignEvidenceIds(input: {
    item: AgentArtifactItem;
    requirements: GenerateArtifactsInput["requirements"];
    retrievedExperiences: GenerateArtifactsInput["retrievedExperiences"];
    allowedEvidenceIds: Set<string>;
    allowedSkillIds: Set<string>;
    allowedRequirementIds: Set<string>;
  }): string[] {
    const aligned = new Set(
      input.item.sourceEvidenceIds.filter((id) => input.allowedEvidenceIds.has(id)),
    );

    if (input.item.sourceExperienceIds.length === 0) {
      return Array.from(aligned).slice(0, MAX_ALIGNED_EVIDENCE_IDS);
    }

    const sourceExperienceIds = new Set(input.item.sourceExperienceIds);
    const retrieved = input.retrievedExperiences.filter((entry) =>
      sourceExperienceIds.has(entry.experience.id),
    );

    for (const entry of retrieved) {
      for (const evidence of entry.matchedEvidences) {
        if (
          input.allowedEvidenceIds.has(evidence.id) &&
          this.contentMatchesEvidence(input.item.content, evidence.excerpt)
        ) {
          aligned.add(evidence.id);
        }
      }
    }

    const matchedSkillIds = new Set(
      input.item.matchedSkillIds.filter((id) => input.allowedSkillIds.has(id)),
    );
    for (const entry of retrieved) {
      for (const skill of entry.matchedSkills) {
        if (!matchedSkillIds.has(skill.id)) {
          continue;
        }
        for (const evidenceId of skill.evidenceIds) {
          if (input.allowedEvidenceIds.has(evidenceId)) {
            aligned.add(evidenceId);
          }
        }
      }
    }

    const targetRequirementIds = new Set(
      input.item.targetRequirementIds.filter((id) => input.allowedRequirementIds.has(id)),
    );
    const requiredSkillIds = new Set(
      input.requirements
        .filter((requirement) => targetRequirementIds.has(requirement.id))
        .flatMap((requirement) => requirement.requiredSkillIds),
    );
    for (const entry of retrieved) {
      for (const skill of entry.matchedSkills) {
        if (!requiredSkillIds.has(skill.id)) {
          continue;
        }
        for (const evidenceId of skill.evidenceIds) {
          if (input.allowedEvidenceIds.has(evidenceId)) {
            aligned.add(evidenceId);
          }
        }
      }
    }

    return Array.from(aligned).slice(0, MAX_ALIGNED_EVIDENCE_IDS);
  }

  private contentMatchesEvidence(content: string, excerpt: string): boolean {
    const contentTokens = new Set(tokenize(content));
    const evidenceTokens = tokenize(excerpt);
    const matches = evidenceTokens.filter((token) => contentTokens.has(token));

    return matches.length >= 2 || this.sharedNumber(content, excerpt);
  }

  private sharedNumber(content: string, excerpt: string): boolean {
    const contentNumbers = new Set(content.match(/\d+%?/g) ?? []);
    return (excerpt.match(/\d+%?/g) ?? []).some((number) => contentNumbers.has(number));
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

    const taskInstructions = [
      "Task:",
      "Generate at least 3 grounded resume artifacts.",
      "Use only the IDs shown below.",
      "Each artifact should target only the requirements it directly proves.",
      "Each artifact should cite 1-3 directly relevant evidence IDs.",
      "Do not attach unrelated targetRequirementIds.",
      "Do not invent facts or IDs.",
    ].join("\n");

    return [
      taskInstructions,
      `Target role: ${input.targetRole}`,
      `Job description: ${input.jdText}`,
      `Requirements:`,
      ...requirementLines,
      `Retrieved experiences:`,
      experienceLines.length > 0 ? experienceLines.join("\n") : "(none)",
    ].join("\n");
  }
}
