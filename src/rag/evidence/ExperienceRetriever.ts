import type { ExperienceService } from "../../product/services/index.js";
import type {
  EvidenceRAGExperience,
  JDRequirement,
  RequirementQueryPlan,
  RetrievedExperience,
  RetrievalMode,
} from "./types.js";
import {
  buildExperienceCorpusStats,
  hasStrongMatch,
  minimumRetrievalScore,
  scoreExperience,
} from "./EvidenceScoring.js";

export class ExperienceRetriever {
  public constructor(private readonly experienceService: ExperienceService) {}

  public async retrieve(input: {
    userId: string;
    requirements: JDRequirement[];
    queryPlans: RequirementQueryPlan[];
    limit?: number;
    mode?: RetrievalMode;
    excludeExperienceIds?: string[];
  }): Promise<RetrievedExperience[]> {
    const experiences = await this.experienceService.listExperiences(input.userId, { limit: 500, status: "active" });
    const normalized = experiences as EvidenceRAGExperience[];
    const corpus = buildExperienceCorpusStats(normalized);
    const plans = new Map(input.queryPlans.map((plan) => [plan.requirementId, plan]));
    const mode = input.mode ?? "initial";
    const excluded = new Set(input.excludeExperienceIds ?? []);

    const scored = normalized
      .filter((experience) => !excluded.has(experience.id))
      .map((experience) => {
        const result = scoreExperience(experience, input.requirements, plans, corpus, mode);
        return {
          experience,
          score: result.score,
          matchedTerms: result.matchedTerms,
          matchedRequirementIds: result.matchedRequirementIds,
          strategyScores: result.strategyScores,
          mode,
          reason: buildReason(result.strategyScores, result.matchedTerms, mode),
          _requirementScores: result.requirementScores,
        };
      })
      .filter((item) => item.score >= minimumRetrievalScore(mode) && hasStrongMatch({ requirementScores: item._requirementScores, matchedTerms: item.matchedTerms }, mode))
      .sort((a, b) => b.score - a.score || b.matchedRequirementIds.length - a.matchedRequirementIds.length);

    return diversitySelect(scored, input.requirements, input.limit ?? 12).map(({ _requirementScores: _ignored, ...item }) => item);
  }
}

function diversitySelect<T extends RetrievedExperience & { _requirementScores: Array<{ requirementId: string; score: number }> }>(
  candidates: T[],
  requirements: JDRequirement[],
  limit: number,
): T[] {
  const selected: T[] = [];
  const selectedIds = new Set<string>();
  const perRequirement = new Map<string, number>();
  const importantRequirementIds = requirements
    .filter((requirement) => requirement.importance === "critical" || requirement.importance === "high")
    .map((requirement) => requirement.id);

  for (const requirementId of importantRequirementIds) {
    const candidate = candidates.find((item) => !selectedIds.has(item.experience.id) && item.matchedRequirementIds.includes(requirementId));
    if (!candidate) continue;
    selected.push(candidate);
    selectedIds.add(candidate.experience.id);
    for (const id of candidate.matchedRequirementIds) perRequirement.set(id, (perRequirement.get(id) ?? 0) + 1);
    if (selected.length >= limit) return selected;
  }

  for (const candidate of candidates) {
    if (selectedIds.has(candidate.experience.id)) continue;
    const novelty = candidate.matchedRequirementIds.filter((id) => (perRequirement.get(id) ?? 0) < 2).length;
    const duplicateTitle = selected.some((item) => normalizeTitle(item.experience.title) === normalizeTitle(candidate.experience.title));
    if (duplicateTitle && novelty === 0) continue;
    if (candidate.matchedRequirementIds.length > 0 && novelty === 0 && selected.length >= Math.ceil(limit / 2)) continue;
    selected.push(candidate);
    selectedIds.add(candidate.experience.id);
    for (const id of candidate.matchedRequirementIds) perRequirement.set(id, (perRequirement.get(id) ?? 0) + 1);
    if (selected.length >= limit) break;
  }
  return selected;
}

function buildReason(
  scores: RetrievedExperience["strategyScores"],
  matchedTerms: string[],
  mode: RetrievalMode,
): string {
  const channels = [
    scores.exactPhrase >= 0.15 ? "exact phrase" : "",
    scores.structured >= 0.15 ? "structured skill" : "",
    scores.lexical >= 0.15 ? "lexical" : "",
    scores.semanticAlias >= 0.15 ? "semantic alias" : "",
  ].filter(Boolean);
  return `${mode === "corrective" ? "Corrective retrieval" : "Initial retrieval"} matched ${channels.join(" + ") || "JD evidence"}${matchedTerms.length > 0 ? `: ${matchedTerms.slice(0, 8).join(", ")}` : ""}.`;
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
