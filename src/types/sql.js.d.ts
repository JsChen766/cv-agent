declare module "sql.js" {
  export type SqlValue = string | number | Uint8Array | null;

  export type QueryExecResult = {
    columns: string[];
    values: SqlValue[][];
  };

  export type Statement = {
    bind(values?: SqlValue[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, SqlValue>;
    free(): boolean;
  };

  export type Database = {
    run(sql: string, params?: SqlValue[]): Database;
    exec(sql: string, params?: SqlValue[]): QueryExecResult[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
  };

  export type SqlJsStatic = {
    Database: new (data?: Uint8Array) => Database;
  };

  export default function initSqlJs(config?: unknown): Promise<SqlJsStatic>;
}
