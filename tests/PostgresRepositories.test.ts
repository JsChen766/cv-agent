import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresDocumentRepository } from "../src/persistence/postgres/index.js";
import type { PostgresQueryResult } from "../src/persistence/postgres/PostgresDatabase.js";
import type { ExtractedTextDocument } from "../src/tools/document/types.js";

class FakePostgresDatabase {
  public readonly queries: Array<{ sql: string; params: unknown[] }> = [];
  public nextRows: QueryResultRow[] = [];

  public async query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.queries.push({ sql, params });
    return {
      rows: this.nextRows as Row[],
      rowCount: this.nextRows.length,
    };
  }
}

describe("PostgreSQL repositories", () => {
  it("sends document upsert SQL and JSON metadata through the database boundary", async () => {
    const database = new FakePostgresDatabase();
    const repository = new PostgresDocumentRepository(database);
    const document: ExtractedTextDocument = {
      documentId: "doc-1",
      userId: "user-1",
      sourceType: "markdown",
      fileName: "resume.md",
      mimeType: "text/markdown",
      text: "Built React systems.",
      textPreview: "Built React systems.",
      textLength: 20,
      sourceRef: "upload:resume.md",
      metadata: {
        parser: "markdown",
        wordCount: 3,
      },
      createdAt: "2024-01-01T00:00:00.000Z",
    };

    await repository.save(document);

    expect(database.queries).toHaveLength(1);
    expect(database.queries[0].sql).toContain("INSERT INTO documents");
    expect(database.queries[0].sql).toContain("ON CONFLICT (id) DO UPDATE");
    expect(database.queries[0].params[0]).toBe("doc-1");
    expect(database.queries[0].params[1]).toBe("user-1");
    expect(database.queries[0].params[13]).toBe(JSON.stringify(document.metadata));
  });

  it("isolates document reads by user id", async () => {
    const database = new FakePostgresDatabase();
    const repository = new PostgresDocumentRepository(database);

    await repository.getById("user-1", "doc-1");
    await repository.listByUserId("user-1");

    expect(database.queries[0].sql).toContain("WHERE user_id = $1 AND id = $2");
    expect(database.queries[0].params).toEqual(["user-1", "doc-1"]);
    expect(database.queries[1].sql).toContain("WHERE user_id = $1");
    expect(database.queries[1].params).toEqual(["user-1"]);
  });
});
