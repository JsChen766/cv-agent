import type { GuidelineRepository } from "./GuidelineRepository.js";
import type { GuidelineQueryPlan, GuidelineRoleAnalysis, GuidelineSourceType, RetrievedGuideline } from "./types.js";
import { normalizeText, scoreTextOverlap, unique } from "./textUtils.js";

export class GuidelineRetriever {
  public constructor(private readonly repository: GuidelineRepository) {}

  public async retrieve(input: {
    analysis: GuidelineRoleAnalysis;
    queryPlan: GuidelineQueryPlan;
    limit?: number;
  }): Promise<RetrievedGuideline[]> {
    const candidates = await this.repository.listGuidelineChunks({
      language: input.analysis.language,
      limit: 400,
    });
    const queryTerms = unique([
      ...input.queryPlan.preferredTags,
      ...input.queryPlan.queryVariants,
      ...input.analysis.priorityRequirements,
      ...input.analysis.keywords,
    ]).filter(Boolean);
    const scored = candidates.map((guideline) => scoreGuideline(guideline, input.analysis, input.queryPlan, queryTerms));
    const mandatory = scored
      .filter((item) => item.guideline.metadata.mandatory === true)
      .sort((a, b) => b.score - a.score);
    const selected: RetrievedGuideline[] = [...mandatory];
    const counts = new Map<GuidelineSourceType, number>();
    for (const item of mandatory) counts.set(item.guideline.sourceType, (counts.get(item.guideline.sourceType) ?? 0) + 1);

    for (const item of scored.sort((a, b) => b.score - a.score)) {
      if (selected.some((selectedItem) => selectedItem.guideline.id === item.guideline.id)) continue;
      if (item.score < 0.11) continue;
      const quota = input.queryPlan.sourceQuotas[item.guideline.sourceType] ?? 2;
      if ((counts.get(item.guideline.sourceType) ?? 0) >= quota) continue;
      selected.push({
        ...item,
        score: Math.min(1, item.score + diversityBonus(item.guideline.sourceType, selected)),
      });
      counts.set(item.guideline.sourceType, (counts.get(item.guideline.sourceType) ?? 0) + 1);
      if (selected.length >= (input.limit ?? 12)) break;
    }

    return selected
      .sort((a, b) => Number(Boolean(b.guideline.metadata.mandatory)) - Number(Boolean(a.guideline.metadata.mandatory)) || b.score - a.score)
      .slice(0, input.limit ?? 12);
  }
}

function scoreGuideline(
  guideline: Awaited<ReturnType<GuidelineRepository["listGuidelineChunks"]>>[number],
  analysis: GuidelineRoleAnalysis,
  plan: GuidelineQueryPlan,
  queryTerms: string[],
): RetrievedGuideline {
  const searchable = [
    guideline.title,
    guideline.content,
    guideline.tags.join(" "),
    guideline.roleFamily ?? "",
    guideline.industry ?? "",
    guideline.applicationType ?? "",
  ].join("\n");
  const overlap = scoreTextOverlap(queryTerms, searchable);
  const role = guideline.roleFamily
    ? (plan.roleFamilies.includes(guideline.roleFamily as never) ? 1 : 0)
    : 0.45;
  const language = guideline.language === analysis.language ? 1 : guideline.language === "en" ? 0.5 : 0;
  const application = guideline.applicationType
    ? guideline.applicationType === analysis.applicationType ? 1 : 0
    : 0.45;
  const mandatory = guideline.metadata.mandatory === true ? 1 : 0;
  const tagMatches = guideline.tags.filter((tag) => queryTerms.some((term) => normalizeText(tag).includes(normalizeText(term)) || normalizeText(term).includes(normalizeText(tag))));
  const lexical = Math.min(1, overlap.score * 0.72 + Math.min(0.28, tagMatches.length * 0.07));
  const score = Math.min(1, role * 0.28 + language * 0.12 + application * 0.15 + lexical * 0.35 + mandatory * 0.25);
  const breakdown = { role, language, application, lexical, mandatory, diversity: 0 };
  return {
    guideline,
    score: Number(score.toFixed(4)),
    matchedTags: unique(tagMatches).slice(0, 12),
    matchedKeywords: overlap.matchedTerms.slice(0, 16),
    reason: mandatory
      ? "Mandatory factual-safety guideline included."
      : `role=${role.toFixed(2)}, application=${application.toFixed(2)}, lexical=${lexical.toFixed(2)}; matched ${overlap.matchedTerms.slice(0, 8).join(", ") || "general role strategy"}.`,
    scoreBreakdown: breakdown,
  };
}

function diversityBonus(sourceType: GuidelineSourceType, selected: RetrievedGuideline[]): number {
  return selected.some((item) => item.guideline.sourceType === sourceType) ? 0 : 0.04;
}
