import type { CoverageGapDecisionRecord, CoverageGapDecisionRepository } from "../repositories.js";
import type { PostgresDatabase } from "./PostgresDatabase.js";
import { jsonValue, optionalText, text, timestamp, type PgRow } from "./rowUtils.js";

export class PostgresCoverageGapDecisionRepository implements CoverageGapDecisionRepository {
  public constructor(private readonly database: Pick<PostgresDatabase, "query">) {}

  public async save(decision: CoverageGapDecisionRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO coverage_gap_decisions (
        id, user_id, session_id, gap_id, status, reason, metadata, created_at, updated_at
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
        decision.gapId,
        decision.status,
        decision.reason ?? null,
        JSON.stringify(decision.metadata),
        decision.createdAt,
        decision.updatedAt,
      ],
    );
  }

  public async listBySessionId(userId: string, sessionId: string): Promise<CoverageGapDecisionRecord[]> {
    const result = await this.database.query<PgRow>(
      "SELECT * FROM coverage_gap_decisions WHERE user_id = $1 AND session_id = $2 ORDER BY created_at ASC",
      [userId, sessionId],
    );
    return result.rows.map(toDecision);
  }
}

function toDecision(row: PgRow): CoverageGapDecisionRecord {
  return {
    id: text(row, "id"),
    userId: text(row, "user_id"),
    sessionId: text(row, "session_id"),
    gapId: text(row, "gap_id"),
    status: text(row, "status") as CoverageGapDecisionRecord["status"],
    reason: optionalText(row, "reason"),
    metadata: jsonValue<Record<string, unknown>>(row, "metadata", {}),
    createdAt: timestamp(row, "created_at"),
    updatedAt: optionalText(row, "updated_at") ?? timestamp(row, "created_at"),
  };
}
