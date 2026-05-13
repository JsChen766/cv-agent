import type { JDRequirement } from "../types.js";
import type { JDRequirementRepository } from "../repositories.js";

export class InMemoryJDRequirementRepository
  implements JDRequirementRepository
{
  private readonly store = new Map<string, JDRequirement>();

  async getById(id: string): Promise<JDRequirement | null> {
    return this.store.get(id) ?? null;
  }

  async listByUserId(userId: string): Promise<JDRequirement[]> {
    return Array.from(this.store.values()).filter((r) => r.userId === userId);
  }

  async listByJDId(userId: string, jdId: string): Promise<JDRequirement[]> {
    return Array.from(this.store.values()).filter(
      (r) => r.userId === userId && r.jdId === jdId,
    );
  }

  async save(requirement: JDRequirement): Promise<void> {
    this.store.set(requirement.id, { ...requirement });
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }
}
