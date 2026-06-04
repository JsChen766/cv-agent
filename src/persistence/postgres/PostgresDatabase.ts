import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

export type PostgresDatabaseConfig = {
  connectionString?: string;
  poolConfig?: pg.PoolConfig;
};

export type PostgresQueryResult<Row extends pg.QueryResultRow = pg.QueryResultRow> = {
  rows: Row[];
  rowCount: number;
};

export type PostgresQueryable = {
  query<Row extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<PostgresQueryResult<Row>>;
};

export function splitSqlStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function normalizeQueryResult<Row extends pg.QueryResultRow>(
  result: pg.QueryResult<Row> | pg.QueryResult<Row>[],
): PostgresQueryResult<Row> {
  if (Array.isArray(result)) {
    const last = result[result.length - 1];
    return {
      rows: (last?.rows ?? []) as Row[],
      rowCount: result.reduce((sum, item) => sum + (item.rowCount ?? item.rows.length), 0),
    };
  }

  return {
    rows: result.rows ?? [],
    rowCount: result.rowCount ?? result.rows.length,
  };
}

export class PostgresDatabase {
  private readonly pool: pg.Pool;

  public constructor(config: PostgresDatabaseConfig = {}) {
    this.pool = new Pool({
      ...config.poolConfig,
      ...(config.connectionString ? { connectionString: config.connectionString } : {}),
    });
  }

  public async query<Row extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    const result = (await this.pool.query<Row>(sql, params)) as
      | pg.QueryResult<Row>
      | pg.QueryResult<Row>[];
    return normalizeQueryResult(result);
  }

  public async transaction<T>(
    callback: (client: PostgresQueryable) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback({
        query: async <Row extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []) => {
          const queryResult = (await client.query<Row>(sql, params)) as
            | pg.QueryResult<Row>
            | pg.QueryResult<Row>[];
          return normalizeQueryResult(queryResult);
        },
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async initializeSchema(): Promise<void> {
    for (const statement of splitSqlStatements(SCHEMA_SQL)) {
      await this.query(statement);
    }
  }

  public async runMigrations(): Promise<void> {
    await this.initializeTrackingTable();
    await this.initializeSchema();
    await this.executeMigrationFiles();
  }

  private async initializeTrackingTable(): Promise<void> {
    await this.query(MIGRATION_TRACKING_SQL);
  }

  private async executeMigrationFiles(): Promise<void> {
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");
    let entries: string[];
    try {
      const fs = await import("node:fs/promises");
      entries = await fs.readdir(migrationsDir);
    } catch {
      return;
    }
    const sqlFiles = entries
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const file of sqlFiles) {
      const filePath = join(migrationsDir, file);
      const content = readFileSync(filePath, "utf8").trim();
      if (content.length === 0) continue;

      const checksum = computeFileChecksum(content);

      // Check tracking table for previously executed migration
      const existing = await this.query<{ filename: string; checksum: string }>(
        "SELECT filename, checksum FROM schema_migrations WHERE filename = $1 AND success = true",
        [file],
      );

      if (existing.rows.length > 0) {
        const recordedChecksum = existing.rows[0].checksum;
        if (recordedChecksum !== checksum) {
          throw new Error(
            `Migration "${file}" checksum mismatch. ` +
            `Recorded: ${recordedChecksum.slice(0, 12)}..., ` +
            `Current: ${checksum.slice(0, 12)}.... ` +
            `The migration file has been modified since it was last executed.`,
          );
        }
        continue;
      }

      // Execute migration and record result
      const startMs = Date.now();
      try {
        const statements = splitSqlStatements(content);
        for (const stmt of statements) {
          await this.query(stmt);
        }
        const executionMs = Date.now() - startMs;
        await this.query(
          "INSERT INTO schema_migrations (filename, checksum, executed_at, execution_ms, success) VALUES ($1, $2, NOW(), $3, true)",
          [file, checksum, executionMs],
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        // Best-effort failure recording
        try {
          await this.query(
            "INSERT INTO schema_migrations (filename, checksum, executed_at, success, error_message) VALUES ($1, $2, NOW(), false, $3)",
            [file, checksum, errorMessage],
          );
        } catch {
          // tracking table may not exist yet
        }
        throw error;
      }
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}

const SCHEMA_SQL = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8");

const MIGRATION_TRACKING_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  execution_ms INTEGER,
  success BOOLEAN NOT NULL DEFAULT true,
  error_message TEXT
);
`;

export function computeFileChecksum(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export type MigrationClassification =
  | { action: "execute" }
  | { action: "skip" }
  | { action: "error"; reason: string };

export function classifyMigration(
  filename: string,
  checksum: string,
  executedRows: Array<{ filename: string; checksum: string }>,
): MigrationClassification {
  const existing = executedRows.find((r) => r.filename === filename);
  if (!existing) return { action: "execute" };
  if (existing.checksum === checksum) return { action: "skip" };
  return {
    action: "error",
    reason: `Migration "${filename}" checksum mismatch. Recorded: ${existing.checksum.slice(0, 12)}..., Current: ${checksum.slice(0, 12)}....`,
  };
}
