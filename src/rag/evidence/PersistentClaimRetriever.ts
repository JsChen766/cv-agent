import type { ClaimGraphRepository } from "./ClaimGraphRepository.js";
import type { JDRequirement, ProductEvidenceGraphEdge, RetrievedPersistentClaim } from "./types.js";
import { clamp, scoreTextOverlap, termWeight, unique } from "./textUtils.js";

const MIN_PERSISTENT_SCORE = 0.055;

export class PersistentClaimRetriever {
  public constructor(private readonly repository: ClaimGraphRepository) {}

  public async retrieve(input: {
    userId: string;
    requirements: JDRequirement[];
    limit?: number;
  }): Promise<RetrievedPersistentClaim[]> {
    const claims = await this.repository.listActiveClaimsByUser(input.userId, { limit: 300 });
    if (claims.length === 0) return [];

    const scored = claims.map((claim) => {
      let rawScore = 0;
      const matchedTerms: string[] = [];
      const matchedRequirementIds: string[] = [];
      const searchable = [claim.claim, claim.evidenceText, claim.skills.join(" "), claim.claimType].join("\n");
      for (const requirement of input.requirements) {
        const terms = requirement.keywords.length > 0 ? requirement.keywords : [requirement.text];
        const { score, matchedTerms: termsMatched } = scoreTextOverlap(terms, searchable);
        if (score > 0 && strongTermCount(termsMatched) > 0) {
          rawScore += score * importanceWeight(requirement.importance) * policyWeight(requirement.retrievalPolicies) * riskWeight(claim.riskLevel);
          matchedTerms.push(...termsMatched);
          matchedRequirementIds.push(requirement.id);
        }
      }
      const uniqueTerms = unique(matchedTerms).sort((a, b) => termWeight(b) - termWeight(a));
      return {
        claim,
        score: clamp(rawScore / Math.max(1, Math.min(input.requirements.length, 10)) + claim.confidence * 0.05),
        matchedTerms: uniqueTerms.slice(0, 16),
        matchedRequirementIds: unique(matchedRequirementIds),
        reason: uniqueTerms.length > 0
          ? `Persistent claim matched JD-specific terms: ${uniqueTerms.slice(0, 8).join(", ")}`
          : "Persistent claim available but weakly matched.",
      } satisfies RetrievedPersistentClaim;
    });

    const selected = scored
      .filter((item) => item.score >= MIN_PERSISTENT_SCORE && item.matchedRequirementIds.length > 0 && strongTermCount(item.matchedTerms) > 0)
      .sort((a, b) => b.score - a.score || b.claim.confidence - a.claim.confidence)
      .slice(0, input.limit ?? 30);

    if (selected.length === 0) return [];

    const edges = await this.repository.listGraphEdgesForClaims(input.userId, selected.map((item) => item.claim.id));
    const edgesByClaim = groupEdgesByClaim(edges);
    return selected.map((item) => ({ ...item, graphEdgeIds: edgesByClaim.get(item.claim.id) ?? [] }));
  }
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

function strongTermCount(terms: string[]): number {
  return terms.filter((term) => termWeight(term) >= 0.8).length;
}

function importanceWeight(value: JDRequirement["importance"]): number {
  if (value === "critical") return 1.25;
  if (value === "high") return 1.1;
  if (value === "low") return 0.7;
  return 1;
}

function policyWeight(policies: JDRequirement["retrievalPolicies"]): number {
  if (policies.includes("structured_skill") || policies.includes("keyword_exact")) return 1.15;
  if (policies.includes("claim_verification")) return 1.05;
  return 1;
}

function riskWeight(risk: "low" | "medium" | "high"): number {
  if (risk === "high") return 0.78;
  if (risk === "medium") return 0.9;
  return 1;
}
