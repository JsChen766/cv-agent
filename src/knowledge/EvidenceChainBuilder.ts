import type {
  Evidence,
  EvidenceChain,
  EvidenceChainRisk,
  GeneratedArtifact,
  JDRequirement,
  Skill,
} from "./types.js";
import type { EvidenceRepository, ExperienceRepository } from "./repositories.js";

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
    const experiences = await Promise.all(
      artifact.sourceExperienceIds.map((id) => this.experienceRepo.getById(id)),
    );
    const foundExperiences = experiences.filter(Boolean) as NonNullable<
      Awaited<ReturnType<typeof this.experienceRepo.getById>>
    >[];

    const evidences = await Promise.all(
      artifact.sourceEvidenceIds.map((id) => this.evidenceRepo.getById(id)),
    );
    const foundEvidences = evidences.filter(Boolean) as Evidence[];

    return {
      artifact,
      experiences: foundExperiences,
      evidences: foundEvidences,
      skills,
      requirements,
      risk: this.assessRisk(artifact, foundEvidences, requirements),
      scores: artifact.scores,
    };
  }

  private assessRisk(
    artifact: GeneratedArtifact,
    evidences: Evidence[],
    requirements: JDRequirement[],
  ): EvidenceChainRisk {
    const reasons: string[] = [];
    if (artifact.sourceExperienceIds.length === 0) {
      reasons.push("Artifact has no source experience.");
    }
    if (evidences.length === 0) {
      reasons.push("Artifact has no supporting evidence.");
    }
    if (requirements.length === 0) {
      reasons.push("Artifact has no target JD requirement.");
    }
    if (artifact.scores.evidenceStrength < 0.5) {
      reasons.push("Evidence strength score is low.");
    }

    if (reasons.length === 0) {
      return { level: "low", reasons: [] };
    }
    return {
      level: reasons.length > 1 ? "high" : "medium",
      reasons,
    };
  }
}
