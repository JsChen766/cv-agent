import { z } from "zod";
import { stableId, tokenize } from "../../knowledge/keywordUtils.js";
import { GeneratedArtifactTypeSchema } from "../../knowledge/schemas/GeneratedArtifactSchema.js";
import { parseWithSchema } from "../../knowledge/schemas/validate.js";
import type { BaseAgent } from "../../core/agent/BaseAgent.js";
import { parseAgentJson } from "../../core/json/index.js";
import type { GeneratedArtifact, JDRequirement } from "../../knowledge/types.js";
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
    const evidenceTextById = new Map(
      input.retrievedExperiences.flatMap((entry) =>
        entry.matchedEvidences.map((evidence) => [evidence.id, evidence.excerpt]),
      ),
    );

    return validated.map((item, index) => {
      const sourceExperienceIds = item.sourceExperienceIds.filter((id) => allowedExperienceIds.has(id));
      const matchedSkillIds = item.matchedSkillIds.filter((id) => allowedSkillIds.has(id));
      const initialTargetRequirementIds = item.targetRequirementIds.filter((id) => allowedRequirementIds.has(id));
      const alignedItem = {
        ...item,
        sourceExperienceIds,
        matchedSkillIds,
        targetRequirementIds: initialTargetRequirementIds,
      };
      const sourceEvidenceIds = this.alignEvidenceIds({
        item: alignedItem,
        retrievedExperiences: input.retrievedExperiences,
        allowedEvidenceIds,
        allowedSkillIds,
      });
      const targetRequirementIds = this.filterTargetRequirementIds({
        targetRequirementIds: initialTargetRequirementIds,
        requirements: input.requirements,
        content: item.content,
        evidenceTexts: sourceEvidenceIds
          .map((id) => evidenceTextById.get(id))
          .filter(Boolean) as string[],
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
    retrievedExperiences: GenerateArtifactsInput["retrievedExperiences"];
    allowedEvidenceIds: Set<string>;
    allowedSkillIds: Set<string>;
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
    const evidenceById = new Map(
      retrieved.flatMap((entry) => entry.matchedEvidences.map((evidence) => [evidence.id, evidence])),
    );

    for (const entry of retrieved) {
      for (const evidence of entry.matchedEvidences) {
        if (
          input.allowedEvidenceIds.has(evidence.id) &&
          this.contentStronglyMatchesEvidence(input.item.content, evidence.excerpt)
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
        if (!this.contentMatchesSkill(input.item.content, skill.name)) {
          continue;
        }
        for (const evidenceId of skill.evidenceIds) {
          const evidence = evidenceById.get(evidenceId);
          if (
            evidence &&
            input.allowedEvidenceIds.has(evidenceId) &&
            this.contentStronglyMatchesEvidence(input.item.content, evidence.excerpt)
          ) {
            aligned.add(evidenceId);
          }
        }
      }
    }

    return Array.from(aligned).slice(0, MAX_ALIGNED_EVIDENCE_IDS);
  }

  private contentStronglyMatchesEvidence(content: string, excerpt: string): boolean {
    return this.sharedNumber(content, excerpt) || this.sharedCoreEvidenceTerm(content, excerpt);
  }

  private sharedCoreEvidenceTerm(content: string, excerpt: string): boolean {
    const coreTermGroups = [
      ["react"],
      ["typescript"],
      ["wcag", "accessibility", "accessible", "a11y"],
      ["performance"],
      ["bundle size"],
      ["api integration", "api patterns", "api"],
      ["design system"],
      ["component library"],
    ];
    const normalizedContent = content.toLowerCase();
    const normalizedExcerpt = excerpt.toLowerCase();
    return coreTermGroups.some((terms) =>
      terms.some((term) => normalizedContent.includes(term)) &&
      terms.some((term) => normalizedExcerpt.includes(term)),
    );
  }

  private contentMatchesSkill(content: string, skillName: string): boolean {
    const contentTokens = new Set(tokenize(content));
    const skillTokens = tokenize(skillName);
    if (skillTokens.some((token) => contentTokens.has(token))) {
      return true;
    }

    const normalizedContent = content.toLowerCase();
    if (skillName === "Performance Optimization") {
      return /\b(performance|bundle size)\b/i.test(normalizedContent);
    }
    if (skillName === "Accessibility") {
      return /\b(accessibility|accessible|wcag)\b/i.test(normalizedContent);
    }
    return false;
  }

  private sharedNumber(content: string, excerpt: string): boolean {
    const contentNumbers = new Set(content.match(/\d+%?/g) ?? []);
    return (excerpt.match(/\d+%?/g) ?? []).some((number) => contentNumbers.has(number));
  }

  private filterTargetRequirementIds(input: {
    targetRequirementIds: string[];
    requirements: JDRequirement[];
    content: string;
    evidenceTexts: string[];
  }): string[] {
    const requirementById = new Map(input.requirements.map((requirement) => [requirement.id, requirement]));
    return input.targetRequirementIds.filter((id) => {
      const requirement = requirementById.get(id);
      if (!requirement || !this.isBroadRequirement(requirement)) {
        return true;
      }
      return this.contentAndEvidenceSupportBroadRequirement({
        requirement,
        content: input.content,
        evidenceTexts: input.evidenceTexts,
      });
    });
  }

  private isBroadRequirement(requirement: JDRequirement): boolean {
    return /\b(cross-team|collaboration|collaborate|product impact|measurable impact|business impact|adoption|stakeholder|organization-wide|company-wide)\b/i
      .test(requirement.description);
  }

  private contentAndEvidenceSupportBroadRequirement(input: {
    requirement: JDRequirement;
    content: string;
    evidenceTexts: string[];
  }): boolean {
    const description = input.requirement.description.toLowerCase();
    const evidenceText = input.evidenceTexts.join(" ");
    const checks: Array<() => boolean> = [];

    if (/\b(cross-team|collaboration|collaborate)\b/i.test(description)) {
      checks.push(() =>
        this.supportsCollaboration(input.content) && this.supportsCollaboration(evidenceText),
      );
    }
    if (/\b(product impact|measurable impact|business impact)\b/i.test(description)) {
      checks.push(() =>
        this.supportsImpact(input.content) && this.supportsImpact(evidenceText),
      );
    }
    if (/\badoption\b/i.test(description)) {
      checks.push(() =>
        this.supportsAdoption(input.content) && this.supportsAdoption(evidenceText),
      );
    }
    if (/\bstakeholder\b/i.test(description)) {
      checks.push(() =>
        this.supportsStakeholderWork(input.content) && this.supportsStakeholderWork(evidenceText),
      );
    }
    if (/\b(organization-wide|company-wide)\b/i.test(description)) {
      checks.push(() =>
        this.supportsOrganizationWideScope(input.content) &&
        this.supportsOrganizationWideScope(evidenceText),
      );
    }

    return checks.length > 0 && checks.every((check) => check());
  }

  private supportsCollaboration(text: string): boolean {
    return /\b(collaborat\w*|cross-team|cross-functional|worked with|partnered(?: with)?|worked across teams)\b/i
      .test(text);
  }

  private supportsImpact(text: string): boolean {
    return /%|\bby\s+\d+|\b(reduced|improved|increased|decreased|saved|delivered|lowered|raised|impact|measurable)\b/i
      .test(text);
  }

  private supportsAdoption(text: string): boolean {
    return /\b(adoption|adopted|rollout|rolled out|used by|usage)\b/i.test(text);
  }

  private supportsStakeholderWork(text: string): boolean {
    return /\b(stakeholder|alignment|aligned|requirements|gathered)\b/i.test(text);
  }

  private supportsOrganizationWideScope(text: string): boolean {
    return /\b(organization-wide|company-wide|companywide|company wide|org-wide|org wide|across the organization|across the company)\b/i
      .test(text);
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
