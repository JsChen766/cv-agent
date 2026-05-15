import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs, { type Database, type SqlValue } from "sql.js";

export type SqliteDatabaseConfig = {
  filePath?: string;
};

export class SqliteDatabase {
  private constructor(
    private readonly db: Database,
    private readonly filePath?: string,
  ) {}

  public static async create(config: SqliteDatabaseConfig = {}): Promise<SqliteDatabase> {
    const SQL = await initSqlJs();
    const data = config.filePath && existsSync(config.filePath)
      ? readFileSync(config.filePath)
      : undefined;
    const database = new SqliteDatabase(new SQL.Database(data), config.filePath);
    database.run(SCHEMA_SQL);
    database.ensureMigrations();
    database.persist();
    return database;
  }

  public run(sql: string, params?: SqlValue[]): void {
    this.db.run(sql, params);
  }

  public get(sql: string, params: SqlValue[] = []): Record<string, SqlValue> | null {
    const statement = this.db.prepare(sql);
    try {
      statement.bind(params);
      if (!statement.step()) {
        return null;
      }
      return statement.getAsObject();
    } finally {
      statement.free();
    }
  }

  public all(sql: string, params: SqlValue[] = []): Array<Record<string, SqlValue>> {
    const statement = this.db.prepare(sql);
    const rows: Array<Record<string, SqlValue>> = [];
    try {
      statement.bind(params);
      while (statement.step()) {
        rows.push(statement.getAsObject());
      }
      return rows;
    } finally {
      statement.free();
    }
  }

  public save(): void {
    this.persist();
  }

  public close(): void {
    this.persist();
    this.db.close();
  }

  private persist(): void {
    if (!this.filePath) {
      return;
    }
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, this.db.export());
  }

  private ensureMigrations(): void {
    try {
      this.db.run("ALTER TABLE generated_artifacts ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("duplicate column")) {
        throw error;
      }
    }
  }
}

const SCHEMA_SQL = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8");
