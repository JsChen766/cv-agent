import { randomUUID } from "node:crypto";
import type {
  ArtifactDecisionInput,
  ArtifactDecisionRecord,
  ArtifactDecisionRepository,
} from "./types.js";

export class ArtifactDecisionService {
  public constructor(private readonly repository: ArtifactDecisionRepository) {}

  public async record(input: ArtifactDecisionInput): Promise<ArtifactDecisionRecord> {
    const createdAt = new Date().toISOString();
    const record: ArtifactDecisionRecord = {
      id: `decision-${randomUUID()}`,
      userId: input.userId,
      artifactId: input.artifactId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      decision: input.decision,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.selectedVariantId ? { selectedVariantId: input.selectedVariantId } : {}),
      ...(input.confirmation ? { confirmation: input.confirmation } : {}),
      createdAt,
    };
    await this.repository.save(record);
    return record;
  }

  public listByArtifactId(userId: string, artifactId: string): Promise<ArtifactDecisionRecord[]> {
    return this.repository.listByArtifactId(userId, artifactId);
  }

  public listBySessionId(userId: string, sessionId: string): Promise<ArtifactDecisionRecord[]> {
    return this.repository.listBySessionId(userId, sessionId);
  }
}
