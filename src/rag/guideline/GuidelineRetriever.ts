import type { GuidelineRepository } from "./GuidelineRepository.js";
import type { GuidelineRoleAnalysis, RetrievedGuideline } from "./types.js";
import { scoreTextOverlap, unique } from "./textUtils.js";

export class GuidelineRetriever {
  public constructor(private readonly repository: GuidelineRepository) {}

  public async retrieve(input: {
    analysis: GuidelineRoleAnalysis;
    limit?: number;
  }): Promise<RetrievedGuideline[]> {
    const candidates = await this.repository.listGuidelineChunks({
      language: input.analysis.language,
      roleFamily: input.analysis.roleFamily,
      applicationType: input.analysis.applicationType,
      limit: 200,
    });
    const queryTerms = unique([
      ...(input.analysis.roleFamily ? [input.analysis.roleFamily] : []),
      ...(input.analysis.industry ? [input.analysis.industry] : []),
      input.analysis.applicationType,
      ...input.analysis.priorityRequirements,
      ...input.analysis.keywords,
    ]).filter(Boolean);

    return candidates
      .map((guideline) => {
        const searchable = [guideline.title, guideline.content, guideline.tags.join(" "), guideline.roleFamily ?? "", guideline.industry ?? "", guideline.applicationType ?? ""].join("\n");
        const overlap = scoreTextOverlap(queryTerms, searchable);
        const roleBoost = input.analysis.roleFamily && guideline.roleFamily === input.analysis.roleFamily ? 0.2 : 0;
        const languageBoost = guideline.language === input.analysis.language ? 0.12 : 0;
        const applicationBoost = guideline.applicationType === input.analysis.applicationType ? 0.1 : 0;
        const generalRuleBoost = guideline.sourceType === "rule" ? 0.05 : 0;
        const score = Math.min(1, overlap.score + roleBoost + languageBoost + applicationBoost + generalRuleBoost);
        return {
          guideline,
          score,
          matchedTags: guideline.tags.filter((tag) => overlap.matchedTerms.some((term) => tag.toLowerCase().includes(term))),
          matchedKeywords: overlap.matchedTerms,
          reason: overlap.matchedTerms.length > 0
            ? `Matched guideline terms: ${overlap.matchedTerms.slice(0, 8).join(", ")}`
            : "General guideline selected for baseline writing constraints.",
        } satisfies RetrievedGuideline;
      })
      .filter((item) => item.score > 0.05 || item.guideline.sourceType === "rule")
      .sort((a, b) => b.score - a.score)
      .slice(0, input.limit ?? 8);
  }
}
