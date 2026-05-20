import type { ProductExperienceCategory } from "../../product/types.js";

export function inferExperienceDraft(text: string): {
  title: string;
  content: string;
  category: ProductExperienceCategory;
  tags: string[];
  summary: string;
} {
  const clean = text.trim();
  const firstLine = clean.split(/\r?\n/).find((line) => line.trim())?.trim() ?? clean;
  const lower = clean.toLowerCase();
  const tags = Array.from(new Set(
    (clean.match(/\b(react|typescript|python|sql|data|analysis|dashboard|weex|node|java|aws)\b/gi) ?? [])
      .map((item) => item.toLowerCase()),
  )).slice(0, 8);
  return {
    title: firstLine.replace(/^[-*]\s*/, "").slice(0, 80) || "Untitled experience",
    content: clean,
    category: lower.includes("project") ? "project" : lower.includes("university") ? "education" : "work",
    tags,
    summary: clean.replace(/\s+/g, " ").slice(0, 180),
  };
}

export function searchMatches(query: string, item: { title: string; content?: string; tags?: string[]; organization?: string; role?: string }): boolean {
  const q = query.toLowerCase();
  return [
    item.title,
    item.content ?? "",
    item.organization ?? "",
    item.role ?? "",
    ...(item.tags ?? []),
  ].join(" ").toLowerCase().includes(q);
}
