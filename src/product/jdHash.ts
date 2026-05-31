import { createHash } from "node:crypto";

export function normalizeJDText(rawText: string): string {
  return rawText
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function computeJDHash(rawText: string): string {
  return createHash("sha256").update(normalizeJDText(rawText)).digest("hex");
}
