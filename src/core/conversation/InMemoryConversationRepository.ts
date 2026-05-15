import type { ConversationRepository } from "./ConversationRepository.js";
import type { ConversationSessionSnapshot } from "./types.js";

export class InMemoryConversationRepository implements ConversationRepository {
  private readonly snapshots = new Map<string, ConversationSessionSnapshot>();

  public async save(snapshot: ConversationSessionSnapshot): Promise<void> {
    this.snapshots.set(snapshot.id, snapshot);
  }

  public async getById(id: string): Promise<ConversationSessionSnapshot | null> {
    return this.snapshots.get(id) ?? null;
  }

  public async listIds(): Promise<string[]> {
    return Array.from(this.snapshots.keys());
  }
}
