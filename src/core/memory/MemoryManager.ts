import type { LLMMessage } from "../model/types.js";
import type { StorageAdapter } from "../storage/StorageAdapter.js";
import type { MemoryRecord } from "./types.js";

export class MemoryManager {
  private readonly storage: StorageAdapter;

  public constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  public async appendMessage(sessionId: string, message: LLMMessage): Promise<void> {
    const messages = await this.getMessages(sessionId);
    messages.push(message);
    await this.storage.set<MemoryRecord>(this.key(sessionId), {
      sessionId,
      messages,
      updatedAt: new Date().toISOString()
    });
  }

  public async getMessages(sessionId: string): Promise<LLMMessage[]> {
    const record = await this.storage.get<MemoryRecord>(this.key(sessionId));
    return record?.messages ?? [];
  }

  public async clear(sessionId: string): Promise<void> {
    await this.storage.delete(this.key(sessionId));
  }

  private key(sessionId: string): string {
    return `memory/${sessionId}`;
  }
}
