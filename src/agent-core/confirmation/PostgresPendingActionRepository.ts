import type { QueryResultRow } from "pg";
import type { PostgresQueryable } from "../../persistence/postgres/PostgresDatabase.js";
import type { PendingAction, PendingActionStatus } from "./PendingAction.js";
import type { PendingActionRepository } from "./PendingActionRepository.js";

type PendingActionRow = QueryResultRow & {
  id: string;
  user_id: string;
  session_id: string;
  turn_id?: string | null;
  tool_id: string;
  status: PendingActionStatus;
  title: string;
  summary: string;
  risk_level: PendingAction["riskLevel"];
  input_json?: unknown;
  affected_resources_json?: unknown;
  preview_json?: unknown;
  result_json?: unknown;
  created_at: string | Date;
  expires_at: string | Date;
};

export class PostgresPendingActionRepository implements PendingActionRepository {
  public constructor(private readonly database: PostgresQueryable) {}

  public async create(action: PendingAction): Promise<PendingAction> {
    await this.upsert(action);
    return action;
  }

  public async getById(userId: string, id: string): Promise<PendingAction | undefined> {
    const result = await this.database.query<PendingActionRow>(
      "SELECT * FROM pending_action WHERE user_id = $1 AND id = $2 LIMIT 1",
      [userId, id],
    );
    return result.rows[0] ? toPendingAction(result.rows[0]) : undefined;
  }

  public async list(userId: string, sessionId?: string): Promise<PendingAction[]> {
    const params: unknown[] = [userId];
    const sessionClause = sessionId ? "AND session_id = $2" : "";
    if (sessionId) params.push(sessionId);
    const result = await this.database.query<PendingActionRow>(
      `SELECT * FROM pending_action
       WHERE user_id = $1 ${sessionClause}
       ORDER BY created_at DESC`,
      params,
    );
    return result.rows.map(toPendingAction);
  }

  public async update(action: PendingAction): Promise<PendingAction> {
    await this.upsert(action);
    return action;
  }

  public async updateStatusIfCurrent(
    userId: string,
    id: string,
    currentStatus: PendingActionStatus,
    patch: Partial<PendingAction> & { status: PendingActionStatus },
  ): Promise<PendingAction | undefined> {
    const now = new Date().toISOString();
    const result = await this.database.query<PendingActionRow>(
      `UPDATE pending_action
       SET status = $4,
           input_json = COALESCE($5::jsonb, input_json),
           affected_resources_json = COALESCE($6::jsonb, affected_resources_json),
           preview_json = COALESCE($7::jsonb, preview_json),
           result_json = COALESCE($8::jsonb, result_json),
           title = COALESCE($9, title),
           summary = COALESCE($10, summary),
           risk_level = COALESCE($11, risk_level),
           updated_at = $12,
           confirmed_at = CASE WHEN $4 = 'confirmed' THEN COALESCE(confirmed_at, $12::timestamptz) ELSE confirmed_at END,
           executed_at = CASE WHEN $4 = 'executed' THEN COALESCE(executed_at, $12::timestamptz) ELSE executed_at END,
           failed_at = CASE WHEN $4 = 'failed' THEN COALESCE(failed_at, $12::timestamptz) ELSE failed_at END,
           cancelled_at = CASE WHEN $4 = 'cancelled' THEN COALESCE(cancelled_at, $12::timestamptz) ELSE cancelled_at END
       WHERE user_id = $1 AND id = $2 AND status = $3
       RETURNING *`,
      [
        userId,
        id,
        currentStatus,
        patch.status,
        patch.toolArguments === undefined ? null : JSON.stringify(patch.toolArguments),
        patch.affectedResources === undefined ? null : JSON.stringify(patch.affectedResources),
        patch.preview === undefined ? null : JSON.stringify(patch.preview),
        patch.lastResult === undefined ? null : JSON.stringify(patch.lastResult),
        patch.title ?? null,
        patch.summary ?? null,
        patch.riskLevel ?? null,
        now,
      ],
    );
    return result.rows[0] ? toPendingAction(result.rows[0]) : undefined;
  }

  private async upsert(action: PendingAction): Promise<void> {
    await this.database.query(
      `INSERT INTO pending_action (
         id, user_id, session_id, turn_id, tool_id, status, title, summary, risk_level,
         input_json, affected_resources_json, preview_json, result_json,
         created_at, updated_at, expires_at,
         confirmed_at, executed_at, failed_at, cancelled_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (id) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         session_id = EXCLUDED.session_id,
         turn_id = EXCLUDED.turn_id,
         tool_id = EXCLUDED.tool_id,
         status = EXCLUDED.status,
         title = EXCLUDED.title,
         summary = EXCLUDED.summary,
         risk_level = EXCLUDED.risk_level,
         input_json = EXCLUDED.input_json,
         affected_resources_json = EXCLUDED.affected_resources_json,
         preview_json = EXCLUDED.preview_json,
         result_json = EXCLUDED.result_json,
         updated_at = EXCLUDED.updated_at,
         expires_at = EXCLUDED.expires_at,
         confirmed_at = COALESCE(pending_action.confirmed_at, EXCLUDED.confirmed_at),
         executed_at = COALESCE(pending_action.executed_at, EXCLUDED.executed_at),
         failed_at = COALESCE(pending_action.failed_at, EXCLUDED.failed_at),
         cancelled_at = COALESCE(pending_action.cancelled_at, EXCLUDED.cancelled_at)`,
      [
        action.id,
        action.userId,
        action.sessionId,
        action.turnId ?? null,
        action.toolName,
        action.status,
        action.title,
        action.summary,
        action.riskLevel,
        JSON.stringify(action.toolArguments ?? {}),
        JSON.stringify(action.affectedResources ?? []),
        action.preview === undefined ? null : JSON.stringify(action.preview),
        action.lastResult === undefined ? null : JSON.stringify(action.lastResult),
        action.createdAt,
        new Date().toISOString(),
        action.expiresAt,
        action.status === "confirmed" ? new Date().toISOString() : null,
        action.status === "executed" ? new Date().toISOString() : null,
        action.status === "failed" ? new Date().toISOString() : null,
        action.status === "cancelled" ? new Date().toISOString() : null,
      ],
    );
  }
}

function toPendingAction(row: PendingActionRow): PendingAction {
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    toolName: row.tool_id,
    toolArguments: jsonRecord(row.input_json),
    status: row.status,
    title: row.title,
    summary: row.summary,
    riskLevel: row.risk_level,
    affectedResources: jsonArray(row.affected_resources_json) as PendingAction["affectedResources"],
    ...(row.preview_json !== null && row.preview_json !== undefined ? { preview: row.preview_json as PendingAction["preview"] } : {}),
    ...(row.result_json !== null && row.result_json !== undefined ? { lastResult: row.result_json as PendingAction["lastResult"] } : {}),
    createdAt: timestamp(row.created_at),
    expiresAt: timestamp(row.expires_at),
  };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function timestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
