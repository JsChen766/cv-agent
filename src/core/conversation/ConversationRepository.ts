import type { ConversationSessionSnapshot } from "./types.js";

export interface ConversationRepository {
  save(snapshot: ConversationSessionSnapshot): Promise<void>;
  getById(id: string): Promise<ConversationSessionSnapshot | null>;
  listIds(): Promise<string[]>;
}
