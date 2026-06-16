import type { ClaimGraphRepository } from "./ClaimGraphRepository.js";
import type {
  JDRequirement,
  ProductEvidenceGraphEdge,
  RequirementQueryPlan,
  RetrievedPersistentClaim,
  RetrievalMode,
  RoleSpecificClaimEffectiveness,
} from "./types.js";
import {
  buildClaimCorpusStats,
  hasStrongMatch,
  minimumRetrievalScore,
  scoreClaim,
} from "./EvidenceScoring.js";

export class PersistentClaimRetriever {
  public constructor(private readonly repository: ClaimGraphRepository) {}

  public async retrieve(input: {
    userId: string;
    requirements: JDRequirement[];
    queryPlans: RequirementQueryPlan[];
    limit?: number;
    mode?: RetrievalMode;
    roleFamily?: string;
    excludeClaimIds?: string[];
  }): Promise<RetrievedPersistentClaim[]> {
    const claims = await this.repository.listActiveClaimsByUser(input.userId, { limit: 1200 });
    if (claims.length === 0) return [];

    const mode = input.mode ?? "initial";
    const excluded = new Set(input.excludeClaimIds ?? []);
    const corpus = buildClaimCorpusStats(claims);
    const plans = new Map(input.queryPlans.map((plan) => [plan.requirementId, plan]));
    const effectiveness = await this.loadEffectiveness(input.userId, input.roleFamily, claims.map((claim) => claim.id));

    const scored = claims
      .filter((claim) => !excluded.has(claim.id))
      .map((claim) => {
        const result = scoreClaim(
          claim,
          input.requirements,
          plans,
          corpus,
          mode,
          effectiveness.get(claim.id)?.effectivenessScore ?? 0,
        );
        return {
          claim,
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
      .sort((a, b) => b.score - a.score || b.claim.confidence - a.claim.confidence);

    const selected = diversitySelect(scored, input.requirements, input.limit ?? 36);
    if (selected.length === 0) return [];
    const edges = await this.repository.listGraphEdgesForClaims(input.userId, selected.map((item) => item.claim.id));
    const edgesByClaim = groupEdgesByClaim(edges);
    return selected.map(({ _requirementScores: _ignored, ...item }) => ({
      ...item,
      graphEdgeIds: edgesByClaim.get(item.claim.id) ?? [],
    }));
  }

  private async loadEffectiveness(
    userId: string,
    roleFamily: string | undefined,
    claimIds: string[],
  ): Promise<Map<string, RoleSpecificClaimEffectiveness>> {
    if (!roleFamily || claimIds.length === 0) return new Map();
    const rows = await this.repository.listRoleSpecificClaimEffectiveness(userId, roleFamily, claimIds);
    return new Map(rows.map((row) => [row.claimId, row]));
  }
}

function diversitySelect<T extends RetrievedPersistentClaim & { _requirementScores: Array<{ requirementId: string; score: number }> }>(
  candidates: T[],
  requirements: JDRequirement[],
  limit: number,
): T[] {
  const selected: T[] = [];
  const selectedClaimIds = new Set<string>();
  const perExperience = new Map<string, number>();
  const perRequirement = new Map<string, number>();
  const orderedRequirements = [...requirements].sort((a, b) => importanceRank(b.importance) - importanceRank(a.importance));

  for (const requirement of orderedRequirements) {
    const best = candidates.find((item) => {
      if (selectedClaimIds.has(item.claim.id)) return false;
      if (!item.matchedRequirementIds.includes(requirement.id)) return false;
      return (perExperience.get(item.claim.experienceId) ?? 0) < 3;
    });
    if (!best) continue;
    selected.push(best);
    selectedClaimIds.add(best.claim.id);
    perExperience.set(best.claim.experienceId, (perExperience.get(best.claim.experienceId) ?? 0) + 1);
    for (const id of best.matchedRequirementIds) perRequirement.set(id, (perRequirement.get(id) ?? 0) + 1);
    if (selected.length >= limit) return selected;
  }

  for (const candidate of candidates) {
    if (selectedClaimIds.has(candidate.claim.id)) continue;
    if ((perExperience.get(candidate.claim.experienceId) ?? 0) >= 3) continue;
    const novelty = candidate.matchedRequirementIds.filter((id) => (perRequirement.get(id) ?? 0) < 2).length;
    if (novelty === 0 && selected.length >= Math.ceil(limit * 0.6)) continue;
    selected.push(candidate);
    selectedClaimIds.add(candidate.claim.id);
    perExperience.set(candidate.claim.experienceId, (perExperience.get(candidate.claim.experienceId) ?? 0) + 1);
    for (const id of candidate.matchedRequirementIds) perRequirement.set(id, (perRequirement.get(id) ?? 0) + 1);
    if (selected.length >= limit) break;
  }
  return selected;
}

function groupEdgesByClaim(edges: ProductEvidenceGraphEdge[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const edge of edges) {
    for (const id of [edge.sourceId, edge.targetId]) {
      if (!id.startsWith("pclaim-")) continue;
      const existing = result.get(id) ?? [];
      existing.push(edge.id);
      result.set(id, existing);
    }
  }
  return result;
}

function buildReason(
  scores: RetrievedPersistentClaim["strategyScores"],
  matchedTerms: string[],
  mode: RetrievalMode,
): string {
  const channels = [
    scores.exactPhrase >= 0.15 ? "exact phrase" : "",
    scores.structured >= 0.15 ? "structured skill" : "",
    scores.lexical >= 0.15 ? "lexical" : "",
    scores.semanticAlias >= 0.15 ? "semantic alias" : "",
    (scores.longTermEffectiveness ?? 0) > 0 ? "historical effectiveness" : "",
  ].filter(Boolean);
  return `${mode === "corrective" ? "Corrective claim retrieval" : "Persistent claim retrieval"} matched ${channels.join(" + ") || "JD evidence"}${matchedTerms.length > 0 ? `: ${matchedTerms.slice(0, 8).join(", ")}` : ""}.`;
}

function importanceRank(value: JDRequirement["importance"]): number {
  if (value === "critical") return 4;
  if (value === "high") return 3;
  if (value === "medium") return 2;
  return 1;
}
