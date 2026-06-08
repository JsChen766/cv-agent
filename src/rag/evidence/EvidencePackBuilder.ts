import type { AllowedClaim, EvidenceItem, EvidencePack, ExperienceClaim, JDRequirement, RetrievedExperience } from "./types.js";
import { scoreTextOverlap, unique } from "./textUtils.js";
import { ExperienceClaimExtractor } from "./ExperienceClaimExtractor.js";
import { EvidenceQualityScorer } from "./EvidenceQualityScorer.js";
import { EvidenceGraphBuilder } from "./EvidenceGraphBuilder.js";
import { EvidenceTraceBuilder } from "./EvidenceTraceBuilder.js";

export class EvidencePackBuilder {
  private readonly qualityScorer = new EvidenceQualityScorer();
  private readonly graphBuilder = new EvidenceGraphBuilder();
  private readonly traceBuilder = new EvidenceTraceBuilder();

  public constructor(private readonly claimExtractor: ExperienceClaimExtractor) {}

  public async build(input: {
    requirements: JDRequirement[];
    retrieved: RetrievedExperience[];
  }): Promise<EvidencePack> {
    const claimsByExperience = new Map<string, ExperienceClaim[]>();
    for (const item of input.retrieved) {
      claimsByExperience.set(item.experience.id, await this.claimExtractor.extract(item.experience));
    }

    const allEvidenceItems: EvidenceItem[] = [];
    const allowedClaims: AllowedClaim[] = [];
    const matchedEvidence: EvidencePack["matchedEvidence"] = [];
    const missingRequirements: EvidencePack["missingRequirements"] = [];
    const qualitySignals: EvidencePack["qualitySignals"] = [];

    for (const requirement of input.requirements) {
      const evidenceItems = this.matchRequirement(requirement, input.retrieved, claimsByExperience);
      allEvidenceItems.push(...evidenceItems);
      const scored = this.qualityScorer.score(requirement, evidenceItems);
      matchedEvidence.push({
        requirementId: requirement.id,
        evidenceItems,
        coverage: scored.coverage,
        recommendedAction: scored.recommendedAction,
      });
      qualitySignals.push(scored.signal);
      if (scored.coverage === "no_evidence") {
        missingRequirements.push({
          requirementId: requirement.id,
          requirementText: requirement.text,
          reason: scored.signal.reason,
          recommendedAction: scored.recommendedAction === "ask_user" ? "ask_user" : "alternative_angle",
        });
      }
      for (const item of evidenceItems) {
        for (const claim of item.supportedClaims) {
          allowedClaims.push({
            id: `allowed-${item.id}-${requirement.id}-${allowedClaims.length + 1}`,
            claim,
            requirementIds: [requirement.id],
            experienceId: item.experienceId,
            revisionId: item.revisionId,
            evidenceText: item.evidenceText,
            confidence: item.confidence,
            riskLevel: item.riskLevel,
          });
        }
      }
    }

    const mergedAllowedClaims = mergeAllowedClaims(allowedClaims).slice(0, 40);
    const uniqueEvidenceItems = dedupeEvidenceItems(allEvidenceItems);
    return {
      version: "evidence-rag-v1.5",
      jdRequirements: input.requirements,
      matchedEvidence,
      allowedClaims: mergedAllowedClaims,
      missingRequirements,
      retrievalTrace: this.traceBuilder.retrievalTrace(input.retrieved),
      qualitySignals,
      graphLinks: this.graphBuilder.build({
        requirements: input.requirements,
        allowedClaims: mergedAllowedClaims,
        evidenceItems: uniqueEvidenceItems,
      }),
      usageTrace: this.traceBuilder.usageTrace(input.requirements, mergedAllowedClaims),
    };
  }

  private matchRequirement(
    requirement: JDRequirement,
    retrieved: RetrievedExperience[],
    claimsByExperience: Map<string, ExperienceClaim[]>,
  ): EvidenceItem[] {
    const evidenceItems: EvidenceItem[] = [];
    for (const item of retrieved) {
      const claims = claimsByExperience.get(item.experience.id) ?? [];
      const matchingClaims = claims
        .map((claim) => ({ claim, overlap: scoreTextOverlap(requirement.keywords.length > 0 ? requirement.keywords : [requirement.text], `${claim.claim}\n${claim.evidenceText}\n${claim.skills.join(" ")}`) }))
        .filter(({ overlap }) => overlap.score > 0 || item.matchedRequirementIds.includes(requirement.id))
        .sort((a, b) => b.overlap.score - a.overlap.score || b.claim.confidence - a.claim.confidence)
        .slice(0, 3);

      for (const { claim, overlap } of matchingClaims) {
        evidenceItems.push({
          id: `evidence-${claim.id}-${requirement.id}`,
          experienceId: claim.experienceId,
          revisionId: claim.revisionId,
          title: item.experience.title,
          category: item.experience.category,
          evidenceText: claim.evidenceText,
          skills: unique([...claim.skills, ...overlap.matchedTerms]).slice(0, 12),
          supportedClaims: [claim.claim],
          confidence: Math.min(1, Number((claim.confidence * 0.75 + Math.max(item.score, overlap.score) * 0.25).toFixed(3))),
          riskLevel: claim.riskLevel,
        });
      }
    }
    return dedupeEvidenceItems(evidenceItems).slice(0, 5);
  }
}

function mergeAllowedClaims(claims: AllowedClaim[]): AllowedClaim[] {
  const map = new Map<string, AllowedClaim>();
  for (const claim of claims) {
    const key = `${claim.experienceId}:${claim.claim.toLowerCase().replace(/\W+/g, " ").trim()}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, claim);
      continue;
    }
    existing.requirementIds = unique([...existing.requirementIds, ...claim.requirementIds]);
    existing.confidence = Math.max(existing.confidence, claim.confidence);
    existing.riskLevel = existing.riskLevel === "high" || claim.riskLevel === "high" ? "high" : existing.riskLevel === "medium" || claim.riskLevel === "medium" ? "medium" : "low";
  }
  return [...map.values()].sort((a, b) => b.confidence - a.confidence);
}

function dedupeEvidenceItems(items: EvidenceItem[]): EvidenceItem[] {
  const seen = new Set<string>();
  const result: EvidenceItem[] = [];
  for (const item of items) {
    const key = `${item.experienceId}:${item.evidenceText.toLowerCase().replace(/\W+/g, " ").trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}
