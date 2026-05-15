import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("PostgreSQL schema", () => {
  const schema = readFileSync(join(process.cwd(), "src", "persistence", "postgres", "schema.sql"), "utf8");

  it("defines the core product kernel tables and indexes without requiring a database", () => {
    for (const table of [
      "users",
      "documents",
      "experiences",
      "evidences",
      "skills",
      "jd_profiles",
      "jd_requirements",
      "generated_artifacts",
      "generation_sessions",
      "generation_artifact_bundles",
      "evidence_chain_snapshots",
      "graph_view_snapshots",
      "artifact_decisions",
      "coverage_gap_decisions",
      "agent_runs",
    ]) {
      expect(schema).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }

    expect(schema).toContain("metadata JSONB NOT NULL DEFAULT '{}'::jsonb");
    expect(schema).toContain("generation JSONB NOT NULL");
    expect(schema).toContain("chain JSONB NOT NULL");
    expect(schema).toContain("graph JSONB NOT NULL");
    expect(schema).toContain("CREATE INDEX IF NOT EXISTS idx_documents_user_id");
    expect(schema).toContain("CREATE INDEX IF NOT EXISTS idx_generated_artifacts_target_jd_id");
    expect(schema).toContain("CREATE INDEX IF NOT EXISTS idx_generation_sessions_status");
    expect(schema).toContain("CREATE INDEX IF NOT EXISTS idx_graph_view_snapshots_scope");
  });
});
