import type {
  ArtifactDecisionRecord,
  ArtifactDecisionRepository,
} from "./types.js";

export class InMemoryArtifactDecisionRepository implements ArtifactDecisionRepository {
  private readonly records = new Map<string, ArtifactDecisionRecord>();

  public async save(record: ArtifactDecisionRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  public async listByArtifactId(userId: string, artifactId: string): Promise<ArtifactDecisionRecord[]> {
    return Array.from(this.records.values())
      .filter((record) => record.userId === userId && record.artifactId === artifactId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  public async listBySessionId(userId: string, sessionId: string): Promise<ArtifactDecisionRecord[]> {
    return Array.from(this.records.values())
      .filter((record) => record.userId === userId && record.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
