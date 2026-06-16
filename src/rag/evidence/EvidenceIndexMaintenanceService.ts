import type { ExperienceService } from "../../product/services/index.js";
import type { ClaimGraphIndexer } from "./ClaimGraphIndexer.js";
import type { ClaimGraphRepository } from "./ClaimGraphRepository.js";
import type { EvidenceReindexReport } from "./types.js";

export class EvidenceIndexMaintenanceService {
  public constructor(
    private readonly experienceService: ExperienceService,
    private readonly claimGraphIndexer: ClaimGraphIndexer,
    private readonly claimGraphRepository: ClaimGraphRepository,
  ) {}

  public async reindexUserExperiences(input: { userId: string; limit?: number }): Promise<EvidenceReindexReport> {
    const experiences = await this.experienceService.listExperiences(input.userId, {
      limit: Math.min(Math.max(input.limit ?? 500, 1), 2000),
      status: "active",
    });
    let indexedExperiences = 0;
    const failedExperiences: EvidenceReindexReport["failedExperiences"] = [];

    for (const experience of experiences) {
      try {
        const revisions = await this.experienceService.listRevisions(input.userId, experience.id);
        const revision = revisions.find((item) => item.id === experience.currentRevisionId) ?? revisions.at(-1);
        if (!revision) {
          failedExperiences.push({ experienceId: experience.id, reason: "No revision was found for the active experience." });
          continue;
        }
        await this.claimGraphIndexer.indexExperience({
          userId: input.userId,
          experience,
          revision,
        });
        indexedExperiences += 1;
      } catch (error) {
        failedExperiences.push({
          experienceId: experience.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const activeClaims = await this.claimGraphRepository.listActiveClaimsByUser(input.userId, { limit: 5000 });
    return {
      userId: input.userId,
      scannedExperiences: experiences.length,
      indexedExperiences,
      failedExperiences,
      activeClaims: activeClaims.length,
    };
  }
}
