import type { GenerationSession } from "./types.js";

export interface GenerationSessionRepository {
  save(session: GenerationSession): Promise<void>;
  getById(id: string): Promise<GenerationSession | null>;
  listByUserId(userId: string): Promise<GenerationSession[]>;
}

export class InMemoryGenerationSessionRepository implements GenerationSessionRepository {
  private readonly sessions = new Map<string, GenerationSession>();

  async save(session: GenerationSession): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async getById(id: string): Promise<GenerationSession | null> {
    return this.sessions.get(id) ?? null;
  }

  async listByUserId(userId: string): Promise<GenerationSession[]> {
    return Array.from(this.sessions.values())
      .filter((session) => session.userId === userId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
