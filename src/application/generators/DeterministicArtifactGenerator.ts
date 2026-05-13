import { stableId } from "../../knowledge/keywordUtils.js";
import type { GeneratedArtifact } from "../../knowledge/types.js";
import type { RetrievedExperience } from "../../knowledge/retrieval/ExperienceRetriever.js";
import type { ArtifactGenerator, GenerateArtifactsInput } from "./ArtifactGenerator.js";

type ArtifactStyle = "technical" | "product_impact" | "architecture";

export class DeterministicArtifactGenerator implements ArtifactGenerator {
  async generate(input: GenerateArtifactsInput): Promise<GeneratedArtifact[]> {
    const now = new Date().toISOString();
    const styles: ArtifactStyle[] = ["technical", "product_impact", "architecture"];

    return styles.map((style, index) => {
      const match =
        input.retrievedExperiences.length > 0
          ? input.retrievedExperiences[index % input.retrievedExperiences.length]
          : null;

      const content = match
        ? this.renderBullet(input.targetRole, match, style)
        : this.renderNoEvidenceBullet(input.targetRole, style);

      return this.createArtifact({
        userId: input.userId,
        jdId: input.jdId,
        targetRole: input.targetRole,
        requirements: input.requirements,
        style,
        content,
        sourceExperienceIds: match ? [match.experience.id] : [],
        sourceEvidenceIds: match ? match.matchedEvidences.map((e) => e.id) : [],
        matchedSkillIds: match ? match.matchedSkills.map((s) => s.id) : [],
        score: match ? match.matchScore : 0,
        evidenceStrength: match && match.matchedEvidences.length > 0 ? 0.85 : 0.2,
        now,
      });
    });
  }

  private renderBullet(
    targetRole: string,
    retrievedExperience: RetrievedExperience,
    style: ArtifactStyle,
  ): string {
    const support = retrievedExperience.reason.replace(/\.$/, "").toLowerCase();
    const result = retrievedExperience.experience.star.result;
    const baseContext = `${retrievedExperience.experience.organization} as ${retrievedExperience.experience.role}`;

    if (style === "technical") {
      return `Built ${targetRole} capabilities at ${baseContext}, applying ${support} to deliver ${result}`;
    }
    if (style === "product_impact") {
      return `Improved product outcomes for ${targetRole} work at ${baseContext}, using ${support} to support ${result}`;
    }
    return `Strengthened frontend architecture at ${baseContext} for ${targetRole} scope, connecting ${support} with ${result}`;
  }

  private renderNoEvidenceBullet(targetRole: string, style: ArtifactStyle): string {
    if (style === "technical") {
      return `Draft technical ${targetRole} bullet requires source experience and evidence before use.`;
    }
    if (style === "product_impact") {
      return `Draft product impact ${targetRole} bullet requires quantified supporting evidence before use.`;
    }
    return `Draft architecture ${targetRole} bullet requires architecture evidence before use.`;
  }

  private createArtifact(params: CreateArtifactParams): GeneratedArtifact {
    const score = Number(params.score.toFixed(3));
    return {
      id: stableId("artifact", `${params.userId}:${params.jdId}:${params.style}:${params.content}`),
      userId: params.userId,
      type: "resume_bullet",
      content: params.content,
      sourceExperienceIds: params.sourceExperienceIds,
      sourceEvidenceIds: unique(params.sourceEvidenceIds),
      matchedSkillIds: unique(params.matchedSkillIds),
      targetJDId: params.jdId,
      targetRequirementIds: params.requirements.map((r) => r.id),
      targetRole: params.targetRole,
      scores: {
        overall: score,
        requirementMatch: score,
        evidenceStrength: params.evidenceStrength,
      },
      status: params.sourceEvidenceIds.length > 0 ? "ready" : "needs_review",
      createdAt: params.now,
      updatedAt: params.now,
    };
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

type CreateArtifactParams = {
  userId: string;
  jdId: string;
  targetRole: string;
  requirements: GenerateArtifactsInput["requirements"];
  style: ArtifactStyle;
  content: string;
  sourceExperienceIds: string[];
  sourceEvidenceIds: string[];
  matchedSkillIds: string[];
  score: number;
  evidenceStrength: number;
  now: string;
};
