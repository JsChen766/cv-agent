import { describe, expect, it, vi } from "vitest";
import {
  parseCopilotTurnRow,
  PostgresCopilotTurnRepository,
} from "../src/copilot/persistence/PostgresCopilotPersistence.js";
import type { PgRow } from "../src/persistence/postgres/rowUtils.js";

describe("PostgresCopilotTurnRepository", () => {
  it("normalizes nullable and timestamp completed_at values", () => {
    const base = turnRow();

    expect(parseCopilotTurnRow({ ...base, completed_at: null }).completedAt).toBeUndefined();
    expect(parseCopilotTurnRow({ ...base, completed_at: undefined }).completedAt).toBeUndefined();
    expect(parseCopilotTurnRow({
      ...base,
      completed_at: new Date("2024-01-01T00:00:00.000Z"),
    }).completedAt).toBe("2024-01-01T00:00:00.000Z");
    expect(parseCopilotTurnRow({
      ...base,
      completed_at: "2024-01-01 00:00:00+00",
    }).completedAt).toBe("2024-01-01 00:00:00+00");
  });

  it("accepts null assistant_message_id and error", () => {
    const parsed = parseCopilotTurnRow(turnRow({
      assistant_message_id: null,
      error: null,
      completed_at: null,
    }));

    expect(parsed.assistantMessageId).toBeNull();
    expect(parsed.error).toBeNull();
  });

  it("skips malformed rows when listing turns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const rows = [
      turnRow({ id: "ct-good", completed_at: new Date("2024-01-01T00:00:00.000Z") }),
      { id: "ct-bad", completed_at: new Date("2024-01-02T00:00:00.000Z") } as PgRow,
    ];
    const database = {
      query: async () => ({ rows, rowCount: rows.length }),
    } as unknown as ConstructorParameters<typeof PostgresCopilotTurnRepository>[0];
    const repo = new PostgresCopilotTurnRepository(database);

    try {
      const turns = await repo.listTurns("user-1", "cs-1");
      expect(turns.map((turn) => turn.id)).toEqual(["ct-good"]);
      expect(turns[0]?.completedAt).toBe("2024-01-01T00:00:00.000Z");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

function turnRow(overrides: Partial<PgRow> = {}): PgRow {
  return {
    id: "ct-1",
    session_id: "cs-1",
    user_message_id: "msg-user",
    assistant_message_id: "msg-assistant",
    intent: null,
    status: "completed",
    error: null,
    created_at: "2024-01-01T00:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}
