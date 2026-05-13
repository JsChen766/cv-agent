import type { ExperienceVariant } from "../types.js";
import type { ExperienceVariantRepository } from "../repositories.js";

export class InMemoryExperienceVariantRepository
  implements ExperienceVariantRepository
{
  private readonly store = new Map<string, ExperienceVariant>();

  async getById(id: string): Promise<ExperienceVariant | null> {
    return this.store.get(id) ?? null;
  }

  async getByExperienceId(experienceId: string): Promise<ExperienceVariant[]> {
    return Array.from(this.store.values()).filter(
      (v) => v.experienceId === experienceId,
    );
  }

  async listByUserId(userId: string): Promise<ExperienceVariant[]> {
    return Array.from(this.store.values()).filter((v) => v.userId === userId);
  }

  async save(variant: ExperienceVariant): Promise<void> {
    this.store.set(variant.id, {
      ...variant,
      sourceEvidenceIds: [...variant.sourceEvidenceIds],
      matchedSkillIds: [...variant.matchedSkillIds],
      scores: { ...variant.scores },
    });
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }
}
