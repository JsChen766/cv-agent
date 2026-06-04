import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import type { PostgresQueryResult, PostgresQueryable } from "../src/persistence/postgres/PostgresDatabase.js";
import { PostgresPendingActionRepository } from "../src/agent-core/confirmation/PostgresPendingActionRepository.js";
import type { PendingAction } from "../src/agent-core/confirmation/PendingAction.js";

type Row = QueryResultRow & Record<string, unknown>;

function pending(overrides: Partial<PendingAction> = {}): PendingAction {
  const now = new Date().toISOString();
  return {
    id: "pa-test",
    userId: "user-1",
    sessionId: "cs-test",
    turnId: "ct-test",
    toolName: "save_experience_from_text",
    toolArguments: { text: "Built analytics dashboard." },
    status: "pending",
    title: "Save experience",
    summary: "Confirm save",
    riskLevel: "medium",
    affectedResources: [{ type: "experience" }],
    preview: { after: { title: "Analytics dashboard" } },
    createdAt: now,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

describe("PostgresPendingActionRepository contract", () => {
  it("creates, reads, lists, updates, and conditionally transitions actions", async () => {
    const db = new FakePendingActionDb();
    const repo = new PostgresPendingActionRepository(db);
    const action = await repo.create(pending());

    await expect(repo.getById("wrong-user", action.id)).resolves.toBeUndefined();
    await expect(repo.getById("user-1", action.id)).resolves.toMatchObject({
      id: action.id,
      status: "pending",
      toolArguments: { text: "Built analytics dashboard." },
    });
    await expect(repo.list("user-1", "cs-test")).resolves.toHaveLength(1);

    const confirmed = await repo.updateStatusIfCurrent("user-1", action.id, "pending", { status: "confirmed" });
    expect(confirmed?.status).toBe("confirmed");
    const duplicateConfirm = await repo.updateStatusIfCurrent("user-1", action.id, "pending", { status: "executed" });
    expect(duplicateConfirm).toBeUndefined();

    const executed = await repo.updateStatusIfCurrent("user-1", action.id, "confirmed", {
      status: "executed",
      lastResult: { status: "success", message: "done", visibility: "user_summary" },
    });
    expect(executed?.status).toBe("executed");
    expect(executed?.lastResult).toMatchObject({ status: "success", message: "done" });

    const updated = await repo.update({ ...action, status: "failed", lastResult: { status: "failed", message: "failed" } });
    expect(updated.status).toBe("failed");
    expect((await repo.getById("user-1", action.id))?.lastResult).toMatchObject({ status: "failed" });
  });
});

class FakePendingActionDb implements PostgresQueryable {
  private readonly rows = new Map<string, Row>();

  public async query<RowType extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<PostgresQueryResult<RowType>> {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("INSERT INTO pending_action")) {
      const row = this.rowFromUpsert(params);
      this.rows.set(String(row.id), row);
      return result([]);
    }
    if (normalized.startsWith("SELECT * FROM pending_action WHERE user_id = $1 AND id = $2")) {
      const row = this.rows.get(String(params[1]));
      return result(row && row.user_id === params[0] ? [row] : []);
    }
    if (normalized.startsWith("SELECT * FROM pending_action WHERE user_id = $1")) {
      const rows = Array.from(this.rows.values())
        .filter((row) => row.user_id === params[0] && (params.length < 2 || row.session_id === params[1]))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      return result(rows);
    }
    if (normalized.startsWith("UPDATE pending_action SET status = $4")) {
      const [userId, id, currentStatus, nextStatus] = params;
      const row = this.rows.get(String(id));
      if (!row || row.user_id !== userId || row.status !== currentStatus) return result([]);
      const now = String(params[11]);
      const next: Row = {
        ...row,
        status: nextStatus,
        input_json: params[4] === null ? row.input_json : JSON.parse(String(params[4])),
        affected_resources_json: params[5] === null ? row.affected_resources_json : JSON.parse(String(params[5])),
        preview_json: params[6] === null ? row.preview_json : JSON.parse(String(params[6])),
        result_json: params[7] === null ? row.result_json : JSON.parse(String(params[7])),
        title: params[8] ?? row.title,
        summary: params[9] ?? row.summary,
        risk_level: params[10] ?? row.risk_level,
        updated_at: now,
      };
      this.rows.set(String(id), next);
      return result([next]);
    }
    throw new Error(`Unhandled fake SQL: ${normalized}`);
  }

  private rowFromUpsert(params: unknown[]): Row {
    return {
      id: String(params[0]),
      user_id: String(params[1]),
      session_id: String(params[2]),
      turn_id: params[3] as string | null,
      tool_id: String(params[4]),
      status: String(params[5]),
      title: String(params[6]),
      summary: String(params[7]),
      risk_level: String(params[8]),
      input_json: JSON.parse(String(params[9])),
      affected_resources_json: JSON.parse(String(params[10])),
      preview_json: params[11] === null ? null : JSON.parse(String(params[11])),
      result_json: params[12] === null ? null : JSON.parse(String(params[12])),
      created_at: String(params[13]),
      updated_at: String(params[14]),
      expires_at: String(params[15]),
    };
  }
}

function result<RowType extends QueryResultRow>(rows: QueryResultRow[]): PostgresQueryResult<RowType> {
  return { rows: rows as RowType[], rowCount: rows.length };
}
