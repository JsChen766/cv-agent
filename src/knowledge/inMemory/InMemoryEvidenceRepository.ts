import type { Evidence } from "../types.js";
import type { EvidenceRepository } from "../repositories.js";

export class InMemoryEvidenceRepository implements EvidenceRepository {
  private readonly store = new Map<string, Evidence>();

  async getById(id: string): Promise<Evidence | null> {
    return this.store.get(id) ?? null;
  }

  async getByExperienceId(experienceId: string): Promise<Evidence[]> {
    return Array.from(this.store.values()).filter(
      (e) => e.experienceId === experienceId,
    );
  }

  async save(evidence: Evidence): Promise<void> {
    this.store.set(evidence.id, { ...evidence });
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }
}
