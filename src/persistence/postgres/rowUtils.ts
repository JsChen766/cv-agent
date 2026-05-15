import type { QueryResultRow } from "pg";

export type PgRow = QueryResultRow & Record<string, unknown>;

export function text(row: PgRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Expected PostgreSQL column ${key} to be text.`);
  }
  return value;
}

export function optionalText(row: PgRow, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected PostgreSQL column ${key} to be optional text.`);
  }
  return value;
}

export function numberValue(row: PgRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number") {
    throw new Error(`Expected PostgreSQL column ${key} to be number.`);
  }
  return value;
}

export function jsonValue<T>(row: PgRow, key: string, fallback?: T): T {
  const value = row[key];
  if ((value === null || value === undefined) && fallback !== undefined) {
    return fallback;
  }
  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }
  return value as T;
}

export function timestamp(row: PgRow, key: string): string {
  const value = row[key];
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    return value;
  }
  throw new Error(`Expected PostgreSQL column ${key} to be timestamp.`);
}
