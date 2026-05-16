import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import { normalizeQueryResult, splitSqlStatements } from "../src/persistence/postgres/PostgresDatabase.js";
import type { PostgresQueryResult } from "../src/persistence/postgres/PostgresDatabase.js";

function makeQueryResult<Row extends QueryResultRow>(
  rows: Row[],
  rowCount?: number | null,
): QueryResult<Row> {
  return {
    rows,
    rowCount: rowCount ?? rows.length,
    command: "",
    oid: 0,
    fields: [],
  } as QueryResult<Row>;
}

describe("splitSqlStatements", () => {
  it("returns single statement unchanged without semicolons", () => {
    const result = splitSqlStatements("SELECT 1");
    expect(result).toEqual(["SELECT 1"]);
  });

  it("splits multi-statement SQL by semicolons", () => {
    const result = splitSqlStatements("CREATE TABLE a (id INT); CREATE TABLE b (id INT)");
    expect(result).toEqual(["CREATE TABLE a (id INT)", "CREATE TABLE b (id INT)"]);
  });

  it("trims whitespace from each statement", () => {
    const result = splitSqlStatements("  SELECT 1  ;  SELECT 2  ");
    expect(result).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("ignores empty statements from trailing semicolons", () => {
    const result = splitSqlStatements("SELECT 1;");
    expect(result).toEqual(["SELECT 1"]);
  });

  it("returns empty array for empty input", () => {
    const result = splitSqlStatements("");
    expect(result).toEqual([]);
  });

  it("returns empty array for whitespace-only input", () => {
    const result = splitSqlStatements("   ");
    expect(result).toEqual([]);
  });

  it("handles multiple empty segments from consecutive semicolons", () => {
    const result = splitSqlStatements("SELECT 1;;;SELECT 2");
    expect(result).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("splits realistic CREATE TABLE statements", () => {
    const sql = `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY);
CREATE INDEX IF NOT EXISTS idx_documents_user_id ON documents(user_id);`;
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(3);
    expect(result[0]).toContain("CREATE TABLE IF NOT EXISTS users");
    expect(result[1]).toContain("CREATE TABLE IF NOT EXISTS documents");
    expect(result[2]).toContain("CREATE INDEX IF NOT EXISTS idx_documents_user_id");
  });
});

describe("normalizeQueryResult", () => {
  it("returns rows and rowCount from a single QueryResult", () => {
    const rows: QueryResultRow[] = [{ id: "1", name: "test" }];
    const single = makeQueryResult(rows);

    const result: PostgresQueryResult = normalizeQueryResult(single);

    expect(result.rows).toEqual(rows);
    expect(result.rowCount).toBe(1);
  });

  it("returns empty rows for a single QueryResult with no rows", () => {
    const single = makeQueryResult([], 0);

    const result: PostgresQueryResult = normalizeQueryResult(single);

    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBe(0);
  });

  it("falls back to rows.length when rowCount is null", () => {
    const rows: QueryResultRow[] = [{ id: "1" }, { id: "2" }];
    const single = makeQueryResult(rows, null);

    const result: PostgresQueryResult = normalizeQueryResult(single);

    expect(result.rowCount).toBe(2);
  });

  it("returns last result rows from a QueryResult array", () => {
    const rows1: QueryResultRow[] = [{ id: "1" }];
    const rows2: QueryResultRow[] = [{ id: "2" }, { id: "3" }];
    const array: QueryResult<QueryResultRow>[] = [
      makeQueryResult(rows1),
      makeQueryResult(rows2),
    ];

    const result: PostgresQueryResult = normalizeQueryResult(array);

    expect(result.rows).toEqual(rows2);
  });

  it("sums rowCount across QueryResult array", () => {
    const array: QueryResult<QueryResultRow>[] = [
      makeQueryResult([{ id: "1" }], 1),
      makeQueryResult([{ id: "2" }, { id: "3" }], 2),
      makeQueryResult([], 0),
    ];

    const result = normalizeQueryResult(array);

    expect(result.rowCount).toBe(3);
  });

  it("handles empty QueryResult array", () => {
    const result = normalizeQueryResult([] as unknown as QueryResult<QueryResultRow>[]);

    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBe(0);
  });

  it("handles array item with null rowCount", () => {
    const rows: QueryResultRow[] = [{ id: "1" }, { id: "2" }];
    const array: QueryResult<QueryResultRow>[] = [makeQueryResult(rows, null)];

    const result = normalizeQueryResult(array);

    expect(result.rowCount).toBe(2); // falls back to rows.length
  });
});
