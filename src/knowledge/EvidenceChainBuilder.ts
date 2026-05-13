import type {
  EvidenceChain,
  GeneratedArtifact,
  JDRequirement,
  Skill,
} from "./types.js";
import type { ExperienceRepository, EvidenceRepository } from "./repositories.js";

export class EvidenceChainBuilder {
  constructor(
    private readonly experienceRepo: ExperienceRepository,
    private readonly evidenceRepo: EvidenceRepository,
  ) {}

  async build(
    artifact: GeneratedArtifact,
    skills: Skill[],
    requirement: JDRequirement,
  ): Promise<EvidenceChain> {
    const experience = await this.experienceRepo.getById(artifact.experienceId);
    if (!experience) {
      throw new Error(
        `Experience not found: ${artifact.experienceId}`,
      );
    }

    const evidences = await Promise.all(
      artifact.matchedEvidenceIds.map((id) => this.evidenceRepo.getById(id)),
    );

    const found = evidences.filter(Boolean) as NonNullable<
      Awaited<ReturnType<typeof this.evidenceRepo.getById>>
    >[];

    return {
      artifact,
      experience,
      evidences: found,
      skills,
      requirement,
    };
  }
}
