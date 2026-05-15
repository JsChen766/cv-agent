import type { ArtifactDecisionRecord, ArtifactDecisionRepository } from "../repositories.js";
import type { PostgresDatabase } from "./PostgresDatabase.js";
import { jsonValue, optionalText, text, timestamp, type PgRow } from "./rowUtils.js";

export class PostgresArtifactDecisionRepository implements ArtifactDecisionRepository {
  public constructor(private readonly database: Pick<PostgresDatabase, "query">) {}

  public async save(decision: ArtifactDecisionRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO artifact_decisions (
        id, user_id, session_id, artifact_id, status, reason, metadata, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9
      )
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        reason = EXCLUDED.reason,
        metadata = EXCLUDED.metadata,
        updated_at = EXCLUDED.updated_at`,
      [
        decision.id,
        decision.userId,
        decision.sessionId,
        decision.artifactId,
        decision.status,
        decision.reason ?? null,
        JSON.stringify(decision.metadata),
        decision.createdAt,
        decision.updatedAt,
      ],
    );
  }

  public async listBySessionId(userId: string, sessionId: string): Promise<ArtifactDecisionRecord[]> {
    const result = await this.database.query<PgRow>(
      "SELECT * FROM artifact_decisions WHERE user_id = $1 AND session_id = $2 ORDER BY created_at ASC",
      [userId, sessionId],
    );
    return result.rows.map(toDecision);
  }
}

function toDecision(row: PgRow): ArtifactDecisionRecord {
  return {
    id: text(row, "id"),
    userId: text(row, "user_id"),
    sessionId: text(row, "session_id"),
    artifactId: text(row, "artifact_id"),
    status: text(row, "status") as ArtifactDecisionRecord["status"],
    reason: optionalText(row, "reason"),
    metadata: jsonValue<Record<string, unknown>>(row, "metadata", {}),
    createdAt: timestamp(row, "created_at"),
    updatedAt: optionalText(row, "updated_at") ?? timestamp(row, "created_at"),
  };
}
