import type { AssetManifestItem, UserAssetContext } from "./UserAssetContext.js";

export type MatchResult = {
  status: "unique" | "multiple" | "none";
  match?: AssetManifestItem;
  candidates?: AssetManifestItem[];
};

export class AssetMentionResolver {
  public matchExperience(query: string, context: UserAssetContext): MatchResult {
    return this.match(query, context.experiences);
  }

  public matchJD(query: string, context: UserAssetContext): MatchResult {
    return this.match(query, context.jds);
  }

  public matchResume(query: string, context: UserAssetContext): MatchResult {
    return this.match(query, context.resumes);
  }

  private match(query: string, items: AssetManifestItem[]): MatchResult {
    if (!query.trim() || items.length === 0) return { status: "none" };

    const scored = items.map((item) => ({ item, score: this.score(query, item) }));
    const positive = scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);

    if (positive.length === 0) return { status: "none" };
    if (positive.length === 1) return { status: "unique", match: positive[0].item };

    const top = positive[0];
    const second = positive[1];

    // Multiple items scoring very high → ambiguous, don't guess
    if (second && second.score >= 80) {
      return { status: "multiple", candidates: positive.slice(0, 5).map((entry) => entry.item) };
    }

    if (top.score >= 80 || (top.score >= 50 && top.score - second.score >= 20)) {
      return { status: "unique", match: top.item };
    }

    return { status: "multiple", candidates: positive.slice(0, 5).map((entry) => entry.item) };
  }

  private score(query: string, item: AssetManifestItem): number {
    const q = query.toLowerCase().trim();
    const tokens = q.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return 0;

    // Fields to search across
    const fields = [
      item.title ?? "",
      item.organization ?? "",
      item.company ?? "",
      item.role ?? "",
      item.targetRole ?? "",
      ...(item.tags ?? []),
      item.summary ?? "",
    ];

    let best = 0;

    for (const field of fields) {
      const lower = field.toLowerCase();
      if (!lower) continue;

      // Exact match on field
      if (lower === q) {
        best = Math.max(best, 100);
        break;
      }

      // Full query as substring of field
      if (lower.includes(q)) {
        best = Math.max(best, 80);
        continue;
      }

      // Field as substring of query (e.g., "weex" in "optimize weex experience")
      if (q.includes(lower) && lower.length >= 3) {
        best = Math.max(best, 70);
        continue;
      }

      // Token overlap
      const matched = tokens.filter((token) => lower.includes(token));
      if (matched.length > 0) {
        const ratio = matched.length / tokens.length;
        best = Math.max(best, Math.round(ratio * 50));
      }
    }

    return best;
  }
}
