import type { Experience } from "../types.js";
import type { ExperienceRepository } from "../repositories.js";

export class InMemoryExperienceRepository implements ExperienceRepository {
  private readonly store = new Map<string, Experience>();

  async getById(id: string): Promise<Experience | null> {
    return this.store.get(id) ?? null;
  }

  async list(): Promise<Experience[]> {
    return Array.from(this.store.values());
  }

  async listByUserId(userId: string): Promise<Experience[]> {
    return Array.from(this.store.values()).filter((e) => e.userId === userId);
  }

  async save(experience: Experience): Promise<void> {
    this.store.set(experience.id, { ...experience });
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }
}
