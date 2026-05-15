import type { GraphViewSnapshot, GraphViewSnapshotRepository } from "../repositories.js";
import type { PostgresDatabase } from "./PostgresDatabase.js";
import { jsonValue, optionalText, text, timestamp, type PgRow } from "./rowUtils.js";

export class PostgresGraphViewSnapshotRepository implements GraphViewSnapshotRepository {
  public constructor(private readonly database: Pick<PostgresDatabase, "query">) {}

  public async save(snapshot: GraphViewSnapshot): Promise<void> {
    await this.database.query(
      `INSERT INTO graph_view_snapshots (
        id, user_id, scope_type, scope_id, graph, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5::jsonb, $6, $7
      )
      ON CONFLICT (id) DO UPDATE SET
        scope_type = EXCLUDED.scope_type,
        scope_id = EXCLUDED.scope_id,
        graph = EXCLUDED.graph,
        updated_at = EXCLUDED.updated_at`,
      [
        snapshot.id,
        snapshot.userId,
        snapshot.scopeType,
        snapshot.scopeId,
        JSON.stringify(snapshot.graph),
        snapshot.createdAt,
        snapshot.updatedAt,
      ],
    );
  }

  public async getById(userId: string, id: string): Promise<GraphViewSnapshot | null> {
    const result = await this.database.query<PgRow>(
      "SELECT * FROM graph_view_snapshots WHERE user_id = $1 AND id = $2 LIMIT 1",
      [userId, id],
    );
    return result.rows[0] ? toSnapshot(result.rows[0]) : null;
  }

  public async listByScope(userId: string, scopeType: string, scopeId: string): Promise<GraphViewSnapshot[]> {
    const result = await this.database.query<PgRow>(
      "SELECT * FROM graph_view_snapshots WHERE user_id = $1 AND scope_type = $2 AND scope_id = $3 ORDER BY created_at ASC",
      [userId, scopeType, scopeId],
    );
    return result.rows.map(toSnapshot);
  }
}

function toSnapshot(row: PgRow): GraphViewSnapshot {
  return {
    id: text(row, "id"),
    userId: text(row, "user_id"),
    scopeType: text(row, "scope_type") as GraphViewSnapshot["scopeType"],
    scopeId: text(row, "scope_id"),
    graph: jsonValue<GraphViewSnapshot["graph"]>(row, "graph"),
    createdAt: timestamp(row, "created_at"),
    updatedAt: optionalText(row, "updated_at") ?? timestamp(row, "created_at"),
  };
}
