import type {
  Evidence,
  EvidenceChain,
  EvidenceRequirementMatch,
  EvidenceRiskAssessment,
  Experience,
  GeneratedArtifact,
  JDRequirement,
  Skill,
} from "./types.js";
import type { EvidenceRepository, ExperienceRepository } from "./repositories.js";
import { stableId, tokenize } from "./keywordUtils.js";
import { validateEvidenceChain } from "./schemas.js";

export class EvidenceChainBuilder {
  constructor(
    private readonly experienceRepo: ExperienceRepository,
    private readonly evidenceRepo: EvidenceRepository,
  ) {}

  async build(
    artifact: GeneratedArtifact,
    skills: Skill[],
    requirements: JDRequirement[],
  ): Promise<EvidenceChain> {
    const sourceExperiences = await this.loadExperiences(
      artifact.sourceExperienceIds,
    );
    const sourceEvidences = await this.loadEvidences(artifact.sourceEvidenceIds);
    const sourceSkills = skills.filter((skill) =>
      artifact.matchedSkillIds.includes(skill.id),
    );
    const requirementMatches = requirements.map((requirement) =>
      this.matchRequirement(
        requirement,
        artifact,
        sourceSkills,
        sourceExperiences,
        sourceEvidences,
      ),
    );

    const chain: EvidenceChain = {
      id: stableId("chain", `${artifact.id}:${artifact.updatedAt}`),
      artifact,
      summary: this.buildSummary(artifact, requirementMatches, sourceEvidences),
      requirementMatches,
      sourceExperiences,
      sourceEvidences,
      sourceSkills,
      risk: this.assessRisk(
        artifact,
        requirementMatches,
        sourceExperiences,
        sourceEvidences,
      ),
      scores: artifact.scores,
      createdAt: new Date().toISOString(),
    };

    validateEvidenceChain(chain);
    return chain;
  }

  private async loadExperiences(ids: string[]): Promise<Experience[]> {
    const experiences = await Promise.all(
      ids.map((id) => this.experienceRepo.getById(id)),
    );
    return experiences.filter(Boolean) as Experience[];
  }

  private async loadEvidences(ids: string[]): Promise<Evidence[]> {
    const evidences = await Promise.all(
      ids.map((id) => this.evidenceRepo.getById(id)),
    );
    return evidences.filter(Boolean) as Evidence[];
  }

  private matchRequirement(
    requirement: JDRequirement,
    artifact: GeneratedArtifact,
    sourceSkills: Skill[],
    sourceExperiences: Experience[],
    sourceEvidences: Evidence[],
  ): EvidenceRequirementMatch {
    const requirementTokens = tokenize(requirement.description);
    const matchedSkills = sourceSkills.filter(
      (skill) =>
        requirement.requiredSkillIds.includes(skill.id) ||
        requirementTokens.includes(skill.name.toLowerCase()),
    );
    const matchedSkillIds = new Set(matchedSkills.map((skill) => skill.id));
    const matchedEvidenceIds = new Set<string>();

    for (const skill of matchedSkills) {
      for (const evidenceId of skill.evidenceIds) {
        matchedEvidenceIds.add(evidenceId);
      }
    }
    for (const evidence of sourceEvidences) {
      if (
        requirementTokens.some((token) =>
          evidence.excerpt.toLowerCase().includes(token),
        )
      ) {
        matchedEvidenceIds.add(evidence.id);
      }
    }

    const matchedEvidences = sourceEvidences.filter((evidence) =>
      matchedEvidenceIds.has(evidence.id),
    );
    const matchedExperienceIds = new Set(
      matchedEvidences.map((evidence) => evidence.experienceId),
    );
    for (const experience of sourceExperiences) {
      if (experience.skillIds.some((skillId) => matchedSkillIds.has(skillId))) {
        matchedExperienceIds.add(experience.id);
      }
    }
    const matchedExperiences = sourceExperiences.filter((experience) =>
      matchedExperienceIds.has(experience.id),
    );

    const skillScore =
      requirement.requiredSkillIds.length === 0
        ? 0
        : matchedSkills.length / requirement.requiredSkillIds.length;
    const evidenceScore =
      sourceEvidences.length === 0
        ? 0
        : matchedEvidences.length / sourceEvidences.length;
    const matchScore = Number(
      Math.min(1, skillScore * 0.7 + evidenceScore * 0.3).toFixed(3),
    );

    return {
      requirement,
      matchedSkills,
      matchedExperiences,
      matchedEvidences,
      matchScore,
      matchReason: `Matched ${matchedSkills.length} skill(s) and ${matchedEvidences.length} evidence item(s) for this requirement.`,
    };
  }

  private buildSummary(
    artifact: GeneratedArtifact,
    requirementMatches: EvidenceRequirementMatch[],
    sourceEvidences: Evidence[],
  ): string {
    const matchedRequirements = requirementMatches.filter(
      (match) => match.matchScore > 0,
    ).length;
    return `${artifact.type} is supported by ${sourceEvidences.length} evidence item(s) across ${matchedRequirements} matched requirement(s).`;
  }

  private assessRisk(
    artifact: GeneratedArtifact,
    requirementMatches: EvidenceRequirementMatch[],
    sourceExperiences: Experience[],
    sourceEvidences: Evidence[],
  ): EvidenceRiskAssessment {
    const missingEvidenceClaims: string[] = [];
    const exaggerationWarnings: string[] = [];
    const notes: string[] = [];

    if (sourceExperiences.length === 0) {
      missingEvidenceClaims.push("Generated artifact has no source experience.");
    }
    if (sourceEvidences.length === 0) {
      missingEvidenceClaims.push("Generated artifact has no supporting evidence.");
    }
    for (const match of requirementMatches) {
      if (match.matchedEvidences.length === 0) {
        missingEvidenceClaims.push(
          `No evidence supports requirement: ${match.requirement.description}`,
        );
      }
    }
    if (artifact.scores.evidenceStrength < 0.5) {
      exaggerationWarnings.push("Evidence strength score is below 0.5.");
    }
    if (artifact.status === "needs_review") {
      notes.push("Artifact is marked as needs_review.");
    }

    const truthfulnessRisk = missingEvidenceClaims.length > 0 ? "medium" : "low";
    const exaggerationRisk =
      exaggerationWarnings.length > 0 || artifact.scores.overall < 0.5
        ? "medium"
        : "low";
    const level =
      missingEvidenceClaims.length > 1 || exaggerationWarnings.length > 1
        ? "high"
        : truthfulnessRisk === "medium" || exaggerationRisk === "medium"
          ? "medium"
          : "low";

    return {
      level,
      truthfulnessRisk,
      exaggerationRisk,
      missingEvidenceClaims,
      exaggerationWarnings,
      notes,
    };
  }
}
