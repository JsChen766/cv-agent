import type { GuidelineChunk, GuidelineLanguage } from "./types.js";
import { DEFAULT_GUIDELINES } from "./defaultGuidelines.js";

export interface GuidelineRepository {
  upsertGuidelineChunks(chunks: GuidelineChunk[]): Promise<GuidelineChunk[]>;
  listGuidelineChunks(input: {
    language?: GuidelineLanguage;
    roleFamily?: string;
    applicationType?: string;
    limit?: number;
  }): Promise<GuidelineChunk[]>;
}

export class InMemoryGuidelineRepository implements GuidelineRepository {
  private readonly chunks = new Map<string, GuidelineChunk>();

  public constructor(seed: GuidelineChunk[] = DEFAULT_GUIDELINES) {
    for (const chunk of seed) this.chunks.set(chunk.id, chunk);
  }

  public async upsertGuidelineChunks(chunks: GuidelineChunk[]): Promise<GuidelineChunk[]> {
    for (const chunk of chunks) this.chunks.set(chunk.id, chunk);
    return chunks;
  }

  public async listGuidelineChunks(input: {
    language?: GuidelineLanguage;
    roleFamily?: string;
    applicationType?: string;
    limit?: number;
  } = {}): Promise<GuidelineChunk[]> {
    const result = Array.from(this.chunks.values())
      .filter((chunk) => !input.language || chunk.language === input.language || chunk.language === "en")
      .filter((chunk) => !input.roleFamily || !chunk.roleFamily || chunk.roleFamily === input.roleFamily)
      .filter((chunk) => !input.applicationType || !chunk.applicationType || chunk.applicationType === input.applicationType)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return result.slice(0, input.limit ?? 200);
  }
}
