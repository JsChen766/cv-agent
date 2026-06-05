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

  it("preserves DO $$ blocks with internal semicolons", () => {
    const sql = `DO $$ BEGIN
  ALTER TABLE t ADD CONSTRAINT c CHECK (x IN ('a','b'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;`;
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("DO $$");
    expect(result[0]).toContain("END $$");
  });

  it("preserves multiple DO $$ blocks as separate statements", () => {
    const sql = `DO $$ BEGIN
  ALTER TABLE t1 ADD CONSTRAINT c1 CHECK (x > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE t2 ADD CONSTRAINT c2 CHECK (y > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;`;
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("c1");
    expect(result[1]).toContain("c2");
  });

  it("preserves DO $tag$ blocks with tagged dollar quoting", () => {
    const sql = `DO $func$ BEGIN
  ALTER TABLE t ADD CONSTRAINT c CHECK (x > 0);
END $func$;`;
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("DO $func$");
    expect(result[0]).toContain("END $func$");
  });

  it("handles single-quoted strings containing semicolons", () => {
    const sql = "SELECT 'hello; world' AS text; SELECT 1";
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("SELECT 'hello; world' AS text");
    expect(result[1]).toBe("SELECT 1");
  });

  it("handles line comments with semicolons inside", () => {
    const sql = `SELECT 1; -- this has a ; inside
SELECT 2`;
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[1]).toContain("SELECT 2");
  });

  it("handles block comments with semicolons inside", () => {
    const sql = "SELECT 1; /* SELECT 2; */ SELECT 3";
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("SELECT 1");
    expect(result[1]).toContain("SELECT 3");
  });

  it("handles DO blocks mixed with regular statements", () => {
    const sql = `CREATE TABLE IF NOT EXISTS test (id TEXT PRIMARY KEY);
DO $$ BEGIN
  ALTER TABLE test ADD CONSTRAINT c CHECK (id <> '');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;`;
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("CREATE TABLE");
    expect(result[1]).toContain("DO $$");
  });

  it("handles escaped single quotes in strings", () => {
    const sql = "SELECT 'it''s fine' AS text; SELECT 2";
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("it''s fine");
  });

  it("handles escaped double quotes in identifiers", () => {
    const sql = 'SELECT "he""llo" AS col; SELECT 1';
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('"he""llo"');
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
