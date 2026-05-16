import type {
  ArtifactDecisionRecord,
  ArtifactDecisionRepository,
} from "../../application/decisions/index.js";
import type { PostgresDatabase } from "./PostgresDatabase.js";
import { jsonValue, optionalText, text, timestamp, type PgRow } from "./rowUtils.js";

export class PostgresArtifactDecisionRepository implements ArtifactDecisionRepository {
  public constructor(private readonly database: Pick<PostgresDatabase, "query">) {}

  public async save(record: ArtifactDecisionRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO artifact_decisions (
        id, user_id, artifact_id, session_id, decision, reason, selected_variant_id, confirmation_json, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9
      )`,
      [
        record.id,
        record.userId,
        record.artifactId,
        record.sessionId ?? null,
        record.decision,
        record.reason ?? null,
        record.selectedVariantId ?? null,
        record.confirmation ? JSON.stringify(record.confirmation) : null,
        record.createdAt,
      ],
    );
  }

  public async listByArtifactId(userId: string, artifactId: string): Promise<ArtifactDecisionRecord[]> {
    const result = await this.database.query<PgRow>(
      "SELECT * FROM artifact_decisions WHERE user_id = $1 AND artifact_id = $2 ORDER BY created_at ASC",
      [userId, artifactId],
    );
    return result.rows.map(toDecision);
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
  const confirmation = jsonValue<ArtifactDecisionRecord["confirmation"] | null>(
    row,
    "confirmation_json",
    null,
  );
  return {
    id: text(row, "id"),
    userId: text(row, "user_id"),
    artifactId: text(row, "artifact_id"),
    ...(optionalText(row, "session_id") ? { sessionId: optionalText(row, "session_id") } : {}),
    decision: text(row, "decision") as ArtifactDecisionRecord["decision"],
    ...(optionalText(row, "reason") ? { reason: optionalText(row, "reason") } : {}),
    ...(optionalText(row, "selected_variant_id") ? { selectedVariantId: optionalText(row, "selected_variant_id") } : {}),
    ...(confirmation ? { confirmation } : {}),
    createdAt: timestamp(row, "created_at"),
  };
}
