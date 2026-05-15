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
    const result = await this.pool.query<Row>(sql, params);
    return {
      rows: result.rows,
      rowCount: result.rowCount ?? result.rows.length,
    };
  }

  public async transaction<T>(
    callback: (client: PostgresQueryable) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback({
        query: async <Row extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []) => {
          const queryResult = await client.query<Row>(sql, params);
          return {
            rows: queryResult.rows,
            rowCount: queryResult.rowCount ?? queryResult.rows.length,
          };
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
    await this.query(SCHEMA_SQL);
  }

  public async runMigrations(): Promise<void> {
    await this.initializeSchema();
    await this.executeMigrationFiles();
  }

  private async executeMigrationFiles(): Promise<void> {
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");
    let entries: string[];
    try {
      const fs = await import("node:fs/promises");
      entries = await fs.readdir(migrationsDir);
    } catch {
      // migrations directory does not exist or cannot be read; skip
      return;
    }
    const sqlFiles = entries
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const file of sqlFiles) {
      const filePath = join(migrationsDir, file);
      const content = readFileSync(filePath, "utf8").trim();
      if (content.length === 0) continue;
      // split by semicolons for multi-statement files (simple lightweight approach)
      const statements = content
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      for (const stmt of statements) {
        await this.query(stmt);
      }
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}

const SCHEMA_SQL = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8");
