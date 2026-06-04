import { existsSync, readFileSync } from "node:fs";
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
    expect(schema).toContain("decision TEXT NOT NULL");
    expect(schema).toContain("selected_variant_id TEXT");
    expect(schema).toContain("confirmation_json JSONB");
    expect(schema).toContain("CREATE INDEX IF NOT EXISTS idx_artifact_decisions_user_artifact");
    expect(schema).toContain("CREATE INDEX IF NOT EXISTS idx_artifact_decisions_user_session");
    expect(schema).toContain("CREATE INDEX IF NOT EXISTS idx_artifact_decisions_created_at");
  });

  it("does not contain mixed ALTER statements", () => {
    const stripped = stripSqlComments(schema);
    expect(stripped).not.toMatch(/ALTER\s+TABLE\s+generation_sessions\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+generation/i);
  });

  it("has a migrations directory", () => {
    const migrationsDir = join(process.cwd(), "src", "persistence", "postgres", "migrations");
    expect(existsSync(migrationsDir)).toBe(true);
  });

  it("has 0002 migration with generation column addition", () => {
    const migrationPath = join(process.cwd(), "src", "persistence", "postgres", "migrations", "0002_add_generation_session_generation.sql");
    expect(existsSync(migrationPath)).toBe(true);
    const content = readFileSync(migrationPath, "utf8");
    expect(content).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+generation/i);
  });

  it("has 0003 migration for expanded artifact decisions", () => {
    const migrationPath = join(process.cwd(), "src", "persistence", "postgres", "migrations", "0003_update_artifact_decisions.sql");
    expect(existsSync(migrationPath)).toBe(true);
    const content = readFileSync(migrationPath, "utf8");
    expect(content).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+decision/i);
    expect(content).toMatch(/DROP\s+COLUMN\s+IF\s+EXISTS\s+status/i);
    expect(content).toContain("idx_artifact_decisions_user_artifact");
  });

  it("has 0004 migration for product asset loop tables without foreign keys", () => {
    const migrationPath = join(process.cwd(), "src", "persistence", "postgres", "migrations", "0004_product_asset_loop.sql");
    expect(existsSync(migrationPath)).toBe(true);
    const content = readFileSync(migrationPath, "utf8");
    for (const table of [
      "product_experience",
      "product_experience_revision",
      "product_experience_variant",
      "product_jd",
      "product_resume",
      "product_resume_item",
      "product_generation",
      "product_import_job",
      "product_import_candidate",
      "product_resume_template",
    ]) {
      expect(content).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(stripSqlComments(content)).not.toMatch(/\bREFERENCES\b/i);
    expect(content).toContain("idx_product_experience_user_status");
    expect(content).toContain("idx_product_generation_session_id");
    expect(content).toContain("template-default");
  });

  it("has 0010 migration for persistent pending actions", () => {
    const migrationPath = join(process.cwd(), "src", "persistence", "postgres", "migrations", "0010_pending_action.sql");
    expect(existsSync(migrationPath)).toBe(true);
    const content = readFileSync(migrationPath, "utf8");
    expect(content).toContain("CREATE TABLE IF NOT EXISTS pending_action");
    expect(content).toContain("status TEXT NOT NULL CHECK");
    expect(content).toContain("'pending', 'confirmed', 'cancelled', 'executed', 'expired', 'failed'");
    expect(content).toContain("input_json JSONB NOT NULL DEFAULT '{}'::jsonb");
    expect(content).toContain("result_json JSONB");
    expect(content).toContain("job_id TEXT");
    expect(content).toContain("dedupe_key TEXT");
    expect(content).toContain("idx_pending_action_user_session");
    expect(content).toContain("idx_pending_action_status");
    expect(content).toContain("idx_pending_action_expires_at");
    expect(content).toContain("idx_pending_action_job_id");
  });
});

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/--.*$/gm, ""); // line comments
}
