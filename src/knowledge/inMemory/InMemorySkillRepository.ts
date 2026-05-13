import type { Skill } from "../types.js";
import type { SkillRepository } from "../repositories.js";

export class InMemorySkillRepository implements SkillRepository {
  private readonly store = new Map<string, Skill>();

  async getById(id: string): Promise<Skill | null> {
    return this.store.get(id) ?? null;
  }

  async findByName(userId: string, name: string): Promise<Skill | null> {
    const normalized = name.trim().toLowerCase();
    return (
      Array.from(this.store.values()).find(
        (s) => s.userId === userId && s.name.toLowerCase() === normalized,
      ) ?? null
    );
  }

  async listByUserId(userId: string): Promise<Skill[]> {
    return Array.from(this.store.values()).filter((s) => s.userId === userId);
  }

  async save(skill: Skill): Promise<void> {
    this.store.set(skill.id, { ...skill, evidenceIds: [...skill.evidenceIds] });
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }
}
