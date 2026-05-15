import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("PostgreSQL schema has no database foreign keys", () => {
  const schema = readFileSync(
    join(process.cwd(), "src", "persistence", "postgres", "schema.sql"),
    "utf8",
  );

  it("contains no FOREIGN KEY clause", () => {
    const stripped = stripSqlComments(schema);
    expect(stripped).not.toMatch(/\bFOREIGN\s+KEY\b/i);
  });

  it("contains no REFERENCES clause", () => {
    const stripped = stripSqlComments(schema);
    expect(stripped).not.toMatch(/\bREFERENCES\b/i);
  });
});

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--.*$/gm, "");
}
