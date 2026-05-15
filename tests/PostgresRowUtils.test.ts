import { describe, expect, it } from "vitest";
import { jsonValue, optionalText, timestamp, type PgRow } from "../src/persistence/postgres/rowUtils.js";

describe("PostgreSQL rowUtils", () => {
  it("reads JSONB fields returned as objects", () => {
    const row: PgRow = { metadata: { sourceDocumentId: "doc-1" } };

    expect(jsonValue<Record<string, unknown>>(row, "metadata")).toEqual({
      sourceDocumentId: "doc-1",
    });
  });

  it("reads JSONB fields returned as strings", () => {
    const row: PgRow = { metadata: '{"sourceDocumentId":"doc-1"}' };

    expect(jsonValue<Record<string, unknown>>(row, "metadata")).toEqual({
      sourceDocumentId: "doc-1",
    });
  });

  it("uses fallback for null JSON fields", () => {
    const row: PgRow = { metadata: null };

    expect(jsonValue<Record<string, unknown>>(row, "metadata", {})).toEqual({});
  });

  it("serializes Date timestamps to ISO strings", () => {
    const row: PgRow = { created_at: new Date("2024-01-01T00:00:00.000Z") };

    expect(timestamp(row, "created_at")).toBe("2024-01-01T00:00:00.000Z");
  });

  it("keeps string timestamps and treats null optional text as undefined", () => {
    const row: PgRow = {
      created_at: "2024-01-01T00:00:00.000Z",
      source_document_id: null,
    };

    expect(timestamp(row, "created_at")).toBe("2024-01-01T00:00:00.000Z");
    expect(optionalText(row, "source_document_id")).toBeUndefined();
  });
});
