export function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[\u2010-\u2015]/g, "-").replace(/[^\p{L}\p{N}#+.]+/gu, " ").trim();
}

export function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function tokenize(value: string): string[] {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  return unique(normalized.split(/\s+/).filter((token) => token.length > 1));
}

export function scoreTextOverlap(queryTerms: string[], text: string): { score: number; matchedTerms: string[] } {
  const normalized = normalizeText(text);
  if (!normalized || queryTerms.length === 0) return { score: 0, matchedTerms: [] };
  const terms = unique(queryTerms.flatMap(tokenize));
  if (terms.length === 0) return { score: 0, matchedTerms: [] };
  const matchedTerms = terms.filter((term) => normalized.includes(term));
  return { score: matchedTerms.length / terms.length, matchedTerms };
}
