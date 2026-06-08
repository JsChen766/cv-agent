const STOPWORDS = new Set([
  "and", "or", "the", "a", "an", "to", "of", "in", "for", "with", "on", "by", "as", "at", "from",
  "is", "are", "be", "will", "can", "able", "ability", "you", "your", "we", "our", "this", "that",
  "岗位", "职责", "要求", "负责", "具备", "相关", "能力", "经验", "优先", "熟悉", "了解", "以及", "通过",
]);

export function normalizeText(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[_/|]+/g, " ")
    .replace(/[^\p{L}\p{N}+#.%\-\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(value: string | undefined): string[] {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  const raw = normalized.match(/[\p{L}\p{N}+#.%\-]+/gu) ?? [];
  const tokens = raw
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
  return unique(tokens.flatMap((token) => expandToken(token)));
}

export function extractKeywords(value: string | undefined, limit = 24): string[] {
  const freq = new Map<string, number>();
  for (const token of tokenize(value)) {
    if (token.length < 2) continue;
    freq.set(token, (freq.get(token) ?? 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([token]) => token)
    .slice(0, limit);
}

export function scoreTextOverlap(queryTerms: string[], text: string | undefined): { score: number; matchedTerms: string[] } {
  if (queryTerms.length === 0) return { score: 0, matchedTerms: [] };
  const haystackTokens = new Set(tokenize(text));
  const haystack = normalizeText(text);
  const matchedTerms = unique(queryTerms.filter((term) => haystackTokens.has(term) || haystack.includes(normalizeText(term))));
  const score = matchedTerms.length / Math.max(1, Math.min(queryTerms.length, 12));
  return { score: clamp(score), matchedTerms };
}

export function splitSentences(value: string | undefined, limit = 12): string[] {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return [];
  const pieces = text
    .split(/(?<=[。！？.!?])\s+|[\n;；]+|(?:^|\s)[-*•]\s+/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 8);
  return unique(pieces).slice(0, limit);
}

export function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, Number(value.toFixed(3))));
}

export function safeSlice(value: string | undefined, length: number): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}

export function stringifyStructured(value: Record<string, unknown> | undefined): string {
  if (!value) return "";
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(value)) {
    if (raw == null) continue;
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      parts.push(`${key}: ${String(raw)}`);
    } else if (Array.isArray(raw)) {
      parts.push(`${key}: ${raw.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join(", ")}`);
    }
  }
  return parts.join("\n");
}

function expandToken(token: string): string[] {
  const items = [token];
  if (/^[\p{Script=Han}]{4,}$/u.test(token)) {
    for (let i = 0; i < token.length - 1; i += 1) items.push(token.slice(i, i + 2));
  }
  return items;
}
