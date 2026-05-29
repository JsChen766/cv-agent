export { extractExperienceDraftFromText } from "../../product/experienceDraft.js";

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
