import type {
  EvidenceChainSnapshot,
  EvidenceChainSnapshotRepository,
} from "../repositories.js";
import type { PostgresDatabase } from "./PostgresDatabase.js";
import { jsonValue, optionalText, text, timestamp, type PgRow } from "./rowUtils.js";

export class PostgresEvidenceChainSnapshotRepository implements EvidenceChainSnapshotRepository {
  public constructor(private readonly database: Pick<PostgresDatabase, "query">) {}

  public async save(snapshot: EvidenceChainSnapshot): Promise<void> {
    await this.database.query(
      `INSERT INTO evidence_chain_snapshots (
        id, user_id, session_id, artifact_id, chain, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5::jsonb, $6, $7
      )
      ON CONFLICT (id) DO UPDATE SET
        session_id = EXCLUDED.session_id,
        artifact_id = EXCLUDED.artifact_id,
        chain = EXCLUDED.chain,
        updated_at = EXCLUDED.updated_at`,
      [
        snapshot.id,
        snapshot.userId,
        snapshot.sessionId ?? null,
        snapshot.artifactId ?? null,
        JSON.stringify(snapshot.chain),
        snapshot.createdAt,
        snapshot.updatedAt,
      ],
    );
  }

  public async getById(userId: string, id: string): Promise<EvidenceChainSnapshot | null> {
    const result = await this.database.query<PgRow>(
      "SELECT * FROM evidence_chain_snapshots WHERE user_id = $1 AND id = $2 LIMIT 1",
      [userId, id],
    );
    return result.rows[0] ? toSnapshot(result.rows[0]) : null;
  }

  public async listBySessionId(userId: string, sessionId: string): Promise<EvidenceChainSnapshot[]> {
    const result = await this.database.query<PgRow>(
      "SELECT * FROM evidence_chain_snapshots WHERE user_id = $1 AND session_id = $2 ORDER BY created_at ASC",
      [userId, sessionId],
    );
    return result.rows.map(toSnapshot);
  }

  public async listByArtifactId(userId: string, artifactId: string): Promise<EvidenceChainSnapshot[]> {
    const result = await this.database.query<PgRow>(
      "SELECT * FROM evidence_chain_snapshots WHERE user_id = $1 AND artifact_id = $2 ORDER BY created_at ASC",
      [userId, artifactId],
    );
    return result.rows.map(toSnapshot);
  }
}

function toSnapshot(row: PgRow): EvidenceChainSnapshot {
  return {
    id: text(row, "id"),
    userId: text(row, "user_id"),
    sessionId: optionalText(row, "session_id"),
    artifactId: optionalText(row, "artifact_id"),
    chain: jsonValue<EvidenceChainSnapshot["chain"]>(row, "chain"),
    createdAt: timestamp(row, "created_at"),
    updatedAt: optionalText(row, "updated_at") ?? timestamp(row, "created_at"),
  };
}
