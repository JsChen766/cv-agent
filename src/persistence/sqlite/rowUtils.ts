import type { SqlValue } from "sql.js";

export function text(row: Record<string, SqlValue>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Expected SQLite column ${key} to be text.`);
  }
  return value;
}

export function numberValue(row: Record<string, SqlValue>, key: string): number {
  const value = row[key];
  if (typeof value !== "number") {
    throw new Error(`Expected SQLite column ${key} to be number.`);
  }
  return value;
}

export function jsonValue<T>(row: Record<string, SqlValue>, key: string): T {
  return JSON.parse(text(row, key)) as T;
}
