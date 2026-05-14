import { JsonParseError } from "./JsonParseError.js";

export type ParseAgentJsonOptions = {
  expectedRoot?: "object" | "array";
};

export function parseAgentJson(
  raw: string,
  options?: ParseAgentJsonOptions,
): unknown {
  const candidates = [
    raw.trim(),
    stripCodeFence(raw).trim(),
    extractFirstJsonCandidate(raw),
    extractFirstJsonCandidate(stripCodeFence(raw)),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of unique(candidates)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      assertExpectedRoot(parsed, options?.expectedRoot, raw);
      return parsed;
    } catch (error) {
      if (error instanceof JsonParseError) {
        throw error;
      }
      // Try the next recovery strategy.
    }
  }

  throw new JsonParseError(
    `Agent JSON is not valid JSON. Raw preview: ${preview(raw)}`,
    raw,
  );
}

export function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1] ?? raw;
}

export function extractFirstJsonCandidate(raw: string): string | null {
  const text = raw.trim();
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char !== "{" && char !== "[") {
      continue;
    }

    const end = findMatchingJsonEnd(text, i, char);
    if (end !== -1) {
      return text.slice(i, end + 1);
    }
  }
  return null;
}

export function assertExpectedRoot(
  value: unknown,
  expectedRoot?: "object" | "array",
  raw = "",
): void {
  if (!expectedRoot) {
    return;
  }

  if (expectedRoot === "array") {
    if (!Array.isArray(value)) {
      throw new JsonParseError(
        `Agent JSON root must be an array. Raw preview: ${preview(raw)}`,
        raw,
      );
    }
    return;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new JsonParseError(
      `Agent JSON root must be an object. Raw preview: ${preview(raw)}`,
      raw,
    );
  }
}

function findMatchingJsonEnd(text: string, startIndex: number, opener: "{" | "["): number {
  const stack: string[] = [opener];
  let inString = false;
  let escaped = false;

  for (let i = startIndex + 1; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }
    if (char !== "}" && char !== "]") {
      continue;
    }

    const last = stack.at(-1);
    if ((char === "}" && last !== "{") || (char === "]" && last !== "[")) {
      return -1;
    }
    stack.pop();
    if (stack.length === 0) {
      return i;
    }
  }

  return -1;
}

function preview(raw: string): string {
  return raw.slice(0, 200);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
