import type { GeneratedArtifact } from "../types.js";
import type { GeneratedArtifactRepository } from "../repositories.js";

export class InMemoryGeneratedArtifactRepository
  implements GeneratedArtifactRepository
{
  private readonly store = new Map<string, GeneratedArtifact>();

  async getById(id: string): Promise<GeneratedArtifact | null> {
    return this.store.get(id) ?? null;
  }

  async getByExperienceId(experienceId: string): Promise<GeneratedArtifact[]> {
    return Array.from(this.store.values()).filter(
      (a) => a.sourceExperienceIds.includes(experienceId),
    );
  }

  async listByUserId(userId: string): Promise<GeneratedArtifact[]> {
    return Array.from(this.store.values()).filter((a) => a.userId === userId);
  }

  async save(artifact: GeneratedArtifact): Promise<void> {
    this.store.set(artifact.id, { ...artifact });
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }
}
