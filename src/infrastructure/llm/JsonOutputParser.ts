import type { z } from "zod";

export type JsonOutputKind = "object" | "array" | "value";
export type JsonOutputSource = "fenced" | "raw" | "extracted";
export type JsonOutputParseErrorCode =
  | "EMPTY_OUTPUT"
  | "NO_JSON_FOUND"
  | "INVALID_JSON"
  | "EXPECTED_TYPE_MISMATCH"
  | "SCHEMA_VALIDATION_FAILED";

export class JsonOutputParseError extends Error {
  public readonly code: JsonOutputParseErrorCode;
  public readonly preview: string;

  public constructor(
    code: JsonOutputParseErrorCode,
    message: string,
    options: { preview: string; cause?: unknown },
  ) {
    super(message);
    this.name = "JsonOutputParseError";
    this.code = code;
    this.preview = options.preview;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export type JsonOutputCandidate = {
  text: string;
  source: JsonOutputSource;
};

export type JsonOutputParseOptions<T> = {
  expected?: JsonOutputKind;
  schema?: z.ZodType<T>;
  previewLength?: number;
};

export type JsonOutputParseResult<T> =
  | { ok: true; value: T; source: JsonOutputSource }
  | { ok: false; error: JsonOutputParseError };

export function safeParseJsonOutput<T = unknown>(
  content: string,
  options: JsonOutputParseOptions<T> = {},
): JsonOutputParseResult<T> {
  const preview = previewContent(content, options.previewLength);
  if (content.trim().length === 0) {
    return {
      ok: false,
      error: new JsonOutputParseError("EMPTY_OUTPUT", "LLM output was empty.", { preview }),
    };
  }

  const candidates = extractJsonCandidates(content);
  if (candidates.length === 0) {
    return {
      ok: false,
      error: new JsonOutputParseError("NO_JSON_FOUND", "No JSON object or array was found in LLM output.", { preview }),
    };
  }

  const parseErrors: string[] = [];
  let firstExpectedKindError: JsonOutputParseError | undefined;
  let firstSchemaError: JsonOutputParseError | undefined;
  let sawJsonLikeCandidate = false;
  for (const candidate of candidates) {
    if (looksLikeJsonCandidate(candidate.text)) sawJsonLikeCandidate = true;
    try {
      const value = JSON.parse(candidate.text) as unknown;
      const expectedError = validateExpectedKind(value, options.expected ?? "value");
      if (expectedError) {
        firstExpectedKindError ??= new JsonOutputParseError("EXPECTED_TYPE_MISMATCH", expectedError, { preview });
        continue;
      }
      if (options.schema) {
        const validation = options.schema.safeParse(value);
        if (!validation.success) {
          firstSchemaError ??= new JsonOutputParseError("SCHEMA_VALIDATION_FAILED", "Parsed JSON failed schema validation.", {
            preview,
            cause: validation.error,
          });
          continue;
        }
        return { ok: true, value: validation.data, source: candidate.source };
      }
      return { ok: true, value: value as T, source: candidate.source };
    } catch (error) {
      parseErrors.push(errorMessage(error));
    }
  }

  if (firstSchemaError) return { ok: false, error: firstSchemaError };
  if (firstExpectedKindError) return { ok: false, error: firstExpectedKindError };

  const code: JsonOutputParseErrorCode = sawJsonLikeCandidate ? "INVALID_JSON" : "NO_JSON_FOUND";
  return {
    ok: false,
    error: new JsonOutputParseError(
      code,
      code === "INVALID_JSON"
        ? `Invalid JSON in LLM output. ${parseErrors[0] ?? ""}`.trim()
        : "No JSON object or array was found in LLM output.",
      { preview },
    ),
  };
}

export function parseJsonOutput<T = unknown>(
  content: string,
  options: JsonOutputParseOptions<T> = {},
): T {
  const result = safeParseJsonOutput(content, options);
  if (!result.ok) throw result.error;
  return result.value;
}

export function parseJsonObject<T extends Record<string, unknown> = Record<string, unknown>>(
  content: string,
  options: Omit<JsonOutputParseOptions<T>, "expected"> = {},
): T {
  return parseJsonOutput<T>(content, { ...options, expected: "object" });
}

export function parseJsonArray<T = unknown>(
  content: string,
  options: Omit<JsonOutputParseOptions<T[]>, "expected"> = {},
): T[] {
  return parseJsonOutput<T[]>(content, { ...options, expected: "array" });
}

export function extractJsonCandidates(content: string): JsonOutputCandidate[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  const candidates: JsonOutputCandidate[] = [];
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]?.trim()) candidates.push({ text: match[1].trim(), source: "fenced" });
  }
  candidates.push({ text: trimmed, source: "raw" });
  candidates.push(...balancedJsonSlices(trimmed, "{", "}").map((text) => ({ text, source: "extracted" as const })));
  candidates.push(...balancedJsonSlices(trimmed, "[", "]").map((text) => ({ text, source: "extracted" as const })));

  const unique = new Map<string, JsonOutputCandidate>();
  for (const candidate of candidates) {
    const normalized = candidate.text.trim();
    if (normalized && !unique.has(normalized)) {
      unique.set(normalized, { ...candidate, text: normalized });
    }
  }
  return Array.from(unique.values()).sort((a, b) => b.text.length - a.text.length);
}

export function previewContent(content: string, maxLength = 200): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function balancedJsonSlices(content: string, open: "{" | "[", close: "}" | "]"): string[] {
  const slices: string[] = [];
  for (let start = 0; start < content.length; start += 1) {
    if (content[start] !== open) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < content.length; index += 1) {
      const char = content[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === "\"") inString = false;
        continue;
      }
      if (char === "\"") inString = true;
      else if (char === open) depth += 1;
      else if (char === close) {
        depth -= 1;
        if (depth === 0) {
          slices.push(content.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return slices;
}

function validateExpectedKind(value: unknown, expected: JsonOutputKind): string | null {
  if (expected === "value") return null;
  if (expected === "array") {
    return Array.isArray(value) ? null : "Expected LLM JSON output to be an array.";
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? null
    : "Expected LLM JSON output to be an object.";
}

function looksLikeJsonCandidate(candidate: string): boolean {
  const trimmed = candidate.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("```");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
