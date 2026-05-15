import { stableId, tokenize } from "../../knowledge/keywordUtils.js";
import type {
  Evidence,
  GeneratedArtifact,
  JDRequirement,
  Skill,
} from "../../knowledge/types.js";
import type { RetrievedExperience } from "../../knowledge/retrieval/ExperienceRetriever.js";
import type { ArtifactGenerator, GenerateArtifactsInput, GenerateArtifactsResult } from "./ArtifactGenerator.js";

type ArtifactKind = "design_system" | "accessibility_api" | "performance";

export class DeterministicArtifactGenerator implements ArtifactGenerator {
  async generate(input: GenerateArtifactsInput): Promise<GenerateArtifactsResult> {
    const now = new Date().toISOString();
    const evidenceContext = this.collectEvidenceContext(input.retrievedExperiences);
    const kinds: ArtifactKind[] = ["design_system", "accessibility_api", "performance"];

    const artifacts = kinds.map((kind) => {
      const evidences = this.selectEvidencesForKind(kind, evidenceContext.evidences);
      const content = evidences.length > 0
        ? this.renderEvidenceBullet(kind, evidences)
        : this.renderNoEvidenceBullet(input.targetRole, kind);
      const sourceExperienceIds = unique(evidences.map((evidence) => evidence.experienceId));
      const sourceEvidenceIds = evidences.map((evidence) => evidence.id);
      const matchedSkillIds = this.selectSkillIdsForEvidence(evidences, evidenceContext.skills);

      return this.createArtifact({
        userId: input.userId,
        jdId: input.jdId,
        targetRole: input.targetRole,
        kind,
        content,
        sourceExperienceIds,
        sourceEvidenceIds,
        matchedSkillIds,
        targetRequirementIds: this.selectTargetRequirementIdsForBullet({
          requirements: input.requirements,
          content,
          matchedSkillIds,
        }),
        score: evidences.length > 0 ? evidenceContext.matchScore : 0,
        evidenceStrength: evidences.length > 0 ? 0.85 : 0.2,
        now,
      });
    });
    return {
      artifacts,
      warnings: [],
    };
  }

  private collectEvidenceContext(retrievedExperiences: RetrievedExperience[]) {
    const evidences = new Map<string, Evidence>();
    const skills = new Map<string, Skill>();
    let matchScore = 0;

    for (const retrieved of retrievedExperiences) {
      matchScore = Math.max(matchScore, retrieved.matchScore);
      for (const evidence of [...retrieved.matchedEvidences, ...retrieved.evidences]) {
        evidences.set(evidence.id, evidence);
      }
      for (const skill of [...retrieved.matchedSkills, ...retrieved.skills]) {
        skills.set(skill.id, skill);
      }
    }

    return {
      evidences: Array.from(evidences.values()),
      skills: Array.from(skills.values()),
      matchScore,
    };
  }

  private selectEvidencesForKind(kind: ArtifactKind, evidences: Evidence[]): Evidence[] {
    const keywordGroups: Record<ArtifactKind, RegExp> = {
      design_system: /\b(react|typescript|design system|component library|product teams?|teams?)\b/i,
      accessibility_api: /\b(accessible|accessibility|wcag|component library)\b/i,
      performance: /\b(reduced|improved|performance|bundle size|tree-shaking|lazy loading|\d+%)\b/i,
    };
    const preferred = evidences.filter((evidence) =>
      keywordGroups[kind].test(evidence.excerpt),
    );
    return preferred.slice(0, 2);
  }

  private renderEvidenceBullet(kind: ArtifactKind, evidences: Evidence[]): string {
    const text = evidences.map((evidence) => evidence.excerpt).join(" ");
    const best = this.cleanExcerpt(evidences[0]?.excerpt ?? text);

    if (kind === "design_system") {
      const designSentence = this.findSentence(text, /\b(react|typescript|design system|teams?)\b/i);
      return this.ensureSentence(designSentence ?? best);
    }

    if (kind === "accessibility_api") {
      if (/\baccessible\b/i.test(text) && /\bwcag\b/i.test(text)) {
        return "Built an accessible component library with WCAG practices.";
      }
      const accessibilitySentence = this.findSentence(
        text,
        /\b(accessible|accessibility|wcag|component library)\b/i,
      );
      return this.ensureSentence(this.stripApiClaim(accessibilitySentence ?? best));
    }

    const performanceSentence = this.findSentence(
      text,
      /\b(reduced|improved|performance|bundle size|tree-shaking|lazy loading|\d+%)\b/i,
    );
    return this.ensureSentence(performanceSentence ?? best);
  }

  private findSentence(text: string, pattern: RegExp): string | null {
    const sentences = text
      .split(/(?<=[.!?;])\s+|\r?\n/)
      .map((sentence) => this.cleanExcerpt(sentence))
      .filter(Boolean);
    return sentences.find((sentence) => pattern.test(sentence)) ?? null;
  }

  private renderNoEvidenceBullet(targetRole: string, kind: ArtifactKind): string {
    if (kind === "design_system") {
      return `Draft ${targetRole} design system bullet requires source evidence before use.`;
    }
    if (kind === "accessibility_api") {
      return `Draft ${targetRole} accessibility or API bullet requires source evidence before use.`;
    }
    return `Draft ${targetRole} performance bullet requires quantified source evidence before use.`;
  }

  private selectSkillIdsForEvidence(evidences: Evidence[], skills: Skill[]): string[] {
    const evidenceIds = new Set(evidences.map((evidence) => evidence.id));
    return skills
      .filter((skill) => skill.evidenceIds.some((evidenceId) => evidenceIds.has(evidenceId)))
      .map((skill) => skill.id);
  }

  private selectTargetRequirementIdsForBullet(input: {
    requirements: JDRequirement[];
    content: string;
    matchedSkillIds: string[];
  }): string[] {
    const contentTokens = new Set(tokenize(input.content));
    const targetIds = input.requirements
      .filter((requirement) => {
        if (!this.contentCanTargetRequirement(input.content, requirement)) {
          return false;
        }
        const skillMatch = requirement.requiredSkillIds.some((skillId) =>
          input.matchedSkillIds.includes(skillId),
        );
        if (skillMatch) {
          return true;
        }
        return tokenize(requirement.description).some((token) => contentTokens.has(token));
      })
      .map((requirement) => requirement.id);
    return targetIds.length > 0
      ? unique(targetIds)
      : input.requirements.slice(0, 1).map((requirement) => requirement.id);
  }

  private contentCanTargetRequirement(
    content: string,
    requirement: JDRequirement,
  ): boolean {
    const description = requirement.description.toLowerCase();
    if (/\b(api|integration|data[- ]?flow)\b/i.test(description)) {
      return /\b(api|integration|data[- ]?flow)\b/i.test(content);
    }
    if (/\b(accessibility|accessible|wcag|inclusive design)\b/i.test(description)) {
      return /\b(accessibility|accessible|wcag|a11y)\b/i.test(content);
    }
    if (/\b(design system|component library)\b/i.test(description)) {
      return /\b(design system|component library|components?)\b/i.test(content);
    }
    if (/\b(performance|optimization|bundle|measurable impact)\b/i.test(description)) {
      return /\b(performance|optimization|bundle|reduced|improved|\d+%)\b/i.test(content);
    }
    if (/\b(cross-team|collaboration|communication|stakeholder)\b/i.test(description)) {
      return /\b(cross-team|collaborat\w*|communicat\w*|stakeholder|partnered|worked with)\b/i
        .test(content);
    }
    return true;
  }

  private createArtifact(params: CreateArtifactParams): GeneratedArtifact {
    const score = Number(params.score.toFixed(3));
    const hasEvidence = params.sourceEvidenceIds.length > 0;
    const sourceEvidenceIds = unique(params.sourceEvidenceIds);
    const sourceExperienceIds = unique(params.sourceExperienceIds);
    return {
      id: stableId("artifact", `${params.userId}:${params.jdId}:${params.kind}:${params.content}`),
      userId: params.userId,
      type: "resume_bullet",
      content: params.content,
      sourceExperienceIds,
      sourceEvidenceIds,
      matchedSkillIds: unique(params.matchedSkillIds),
      targetJDId: params.jdId,
      targetRequirementIds: unique(params.targetRequirementIds),
      targetRole: params.targetRole,
      scores: {
        overall: score,
        requirementMatch: score,
        evidenceStrength: params.evidenceStrength,
      },
      status: hasEvidence ? "ready" : "needs_review",
      metadata: {
        enhancement: {
          status: hasEvidence ? "ready" : "needs_confirmation",
          claims: [
            {
              text: params.content,
              supportLevel: hasEvidence ? "supported" : "needs_user_confirmation",
              riskLevel: hasEvidence ? "low" : "medium",
              evidenceIds: hasEvidence ? sourceEvidenceIds : [],
              sourceExperienceIds: hasEvidence ? sourceExperienceIds : [],
            },
          ],
          confirmationQuestions: hasEvidence
            ? []
            : ["Please provide source evidence before using this bullet."],
          enhancementStrategy: hasEvidence ? "evidence_rewrite" : "confirmation_needed",
        },
      },
      createdAt: params.now,
      updatedAt: params.now,
    };
  }

  private cleanExcerpt(excerpt: string): string {
    return excerpt.trim().replace(/\s+/g, " ").replace(/^[-*]\s*/, "");
  }

  private ensureSentence(content: string): string {
    const trimmed = this.cleanExcerpt(content);
    return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  }

  private stripApiClaim(content: string): string {
    return this.cleanExcerpt(content)
      .replace(/\s+and shared API integration patterns\b/i, "")
      .replace(/\s+with shared API integration patterns\b/i, "")
      .replace(/\s+and API integration patterns\b/i, "");
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

type CreateArtifactParams = {
  userId: string;
  jdId: string;
  targetRole: string;
  kind: ArtifactKind;
  content: string;
  sourceExperienceIds: string[];
  sourceEvidenceIds: string[];
  matchedSkillIds: string[];
  targetRequirementIds: string[];
  score: number;
  evidenceStrength: number;
  now: string;
};
