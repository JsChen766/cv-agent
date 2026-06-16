import type {
  AllowedClaim,
  EvidenceItem,
  EvidencePack,
  ExperienceClaim,
  JDRequirement,
  RetrievedExperience,
  RetrievedPersistentClaim,
} from "./types.js";
import { normalizeText, scoreTextOverlap, termWeight, unique } from "./textUtils.js";
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

    return this.buildCore({
      version: "evidence-rag-v5",
      requirements: input.requirements,
      retrievalTrace: this.traceBuilder.retrievalTrace(input.retrieved),
      matchRequirement: (requirement) => this.matchRequirement(requirement, input.retrieved, claimsByExperience),
    });
  }

  public buildFromPersistentClaims(input: {
    requirements: JDRequirement[];
    retrievedClaims: RetrievedPersistentClaim[];
  }): EvidencePack {
    return this.buildCore({
      version: "evidence-rag-v5",
      requirements: input.requirements,
      retrievalTrace: this.traceBuilder.persistentClaimTrace(input.retrievedClaims),
      matchRequirement: (requirement) => this.matchPersistentRequirement(requirement, input.retrievedClaims),
    });
  }

  public mergePacks(primary: EvidencePack, secondary: EvidencePack): EvidencePack {
    const requirements = primary.jdRequirements;
    const allowedClaims = mergeAllowedClaims([...primary.allowedClaims, ...secondary.allowedClaims]).slice(0, 72);
    const matchedEvidence = requirements.map((requirement) => {
      const first = primary.matchedEvidence.find((item) => item.requirementId === requirement.id);
      const second = secondary.matchedEvidence.find((item) => item.requirementId === requirement.id);
      const evidenceItems = selectDiverseEvidence([
        ...(first?.evidenceItems ?? []),
        ...(second?.evidenceItems ?? []),
      ], 6);
      const scored = this.qualityScorer.score(requirement, evidenceItems);
      return {
        requirementId: requirement.id,
        evidenceItems,
        coverage: scored.coverage,
        recommendedAction: scored.recommendedAction,
      };
    });
    const qualitySignals = requirements.map((requirement) => {
      const match = matchedEvidence.find((item) => item.requirementId === requirement.id);
      return this.qualityScorer.score(requirement, match?.evidenceItems ?? []).signal;
    });
    const missingRequirements = buildMissingRequirements(requirements, matchedEvidence, qualitySignals);
    const evidenceItems = dedupeEvidenceItems(matchedEvidence.flatMap((item) => item.evidenceItems));
    return {
      version: "evidence-rag-v5",
      jdRequirements: requirements,
      matchedEvidence,
      allowedClaims,
      missingRequirements,
      retrievalTrace: dedupeRetrievalTrace([...primary.retrievalTrace, ...secondary.retrievalTrace]),
      qualitySignals,
      graphLinks: this.graphBuilder.build({ requirements, allowedClaims, evidenceItems }),
      usageTrace: this.traceBuilder.usageTrace(requirements, allowedClaims),
      longTermMemory: primary.longTermMemory ?? secondary.longTermMemory,
      diagnostics: primary.diagnostics ?? secondary.diagnostics,
    };
  }

  public mergePersistentAndDynamic(persistent: EvidencePack, dynamic: EvidencePack): EvidencePack {
    return this.mergePacks(persistent, dynamic);
  }

  private buildCore(input: {
    version: EvidencePack["version"];
    requirements: JDRequirement[];
    retrievalTrace: EvidencePack["retrievalTrace"];
    matchRequirement: (requirement: JDRequirement) => EvidenceItem[];
  }): EvidencePack {
    const allEvidenceItems: EvidenceItem[] = [];
    const rawAllowedClaims: AllowedClaim[] = [];
    const matchedEvidence: EvidencePack["matchedEvidence"] = [];
    const qualitySignals: EvidencePack["qualitySignals"] = [];

    for (const requirement of input.requirements) {
      const evidenceItems = selectDiverseEvidence(input.matchRequirement(requirement), 6);
      allEvidenceItems.push(...evidenceItems);
      const scored = this.qualityScorer.score(requirement, evidenceItems);
      matchedEvidence.push({
        requirementId: requirement.id,
        evidenceItems,
        coverage: scored.coverage,
        recommendedAction: scored.recommendedAction,
      });
      qualitySignals.push(scored.signal);
      for (const item of evidenceItems) {
        for (const claim of item.supportedClaims) {
          rawAllowedClaims.push({
            id: item.claimId ?? `allowed-${item.id}-${requirement.id}`,
            claimId: item.claimId,
            claimStatus: item.claimStatus,
            graphEdgeIds: item.graphEdgeIds,
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

    const allowedClaims = mergeAllowedClaims(rawAllowedClaims).slice(0, 60);
    const uniqueEvidenceItems = dedupeEvidenceItems(allEvidenceItems);
    const missingRequirements = buildMissingRequirements(input.requirements, matchedEvidence, qualitySignals);
    return {
      version: input.version,
      jdRequirements: input.requirements,
      matchedEvidence,
      allowedClaims,
      missingRequirements,
      retrievalTrace: dedupeRetrievalTrace(input.retrievalTrace),
      qualitySignals,
      graphLinks: this.graphBuilder.build({
        requirements: input.requirements,
        allowedClaims,
        evidenceItems: uniqueEvidenceItems,
      }),
      usageTrace: this.traceBuilder.usageTrace(input.requirements, allowedClaims),
    };
  }

  private matchRequirement(
    requirement: JDRequirement,
    retrieved: RetrievedExperience[],
    claimsByExperience: Map<string, ExperienceClaim[]>,
  ): EvidenceItem[] {
    const evidenceItems: EvidenceItem[] = [];
    const queryTerms = requirement.coreTerms.length > 0 ? requirement.coreTerms : requirement.keywords;
    for (const item of retrieved) {
      if (!item.matchedRequirementIds.includes(requirement.id)) continue;
      const claims = claimsByExperience.get(item.experience.id) ?? [];
      const matchingClaims = claims
        .map((claim) => ({
          claim,
          overlap: scoreTextOverlap(
            queryTerms.length > 0 ? queryTerms : [requirement.text],
            `${claim.claim}\n${claim.evidenceText}\n${claim.skills.join(" ")}`,
          ),
        }))
        .filter(({ claim, overlap }) => {
          const strong = overlap.matchedTerms.some((term) => termWeight(term) >= 0.8);
          if (requirement.strictness === "strict") return overlap.score >= 0.12 && strong;
          return overlap.score >= 0.07 || (strong && item.score >= 0.18);
        })
        .sort((a, b) => b.overlap.score - a.overlap.score || b.claim.confidence - a.claim.confidence)
        .slice(0, 4);

      for (const { claim, overlap } of matchingClaims) {
        evidenceItems.push({
          id: `evidence-${claim.id}-${requirement.id}`,
          experienceId: claim.experienceId,
          revisionId: claim.revisionId,
          title: item.experience.title,
          category: item.experience.category,
          evidenceText: claim.evidenceText,
          skills: unique([...claim.skills, ...overlap.matchedTerms]).slice(0, 16),
          supportedClaims: [claim.claim],
          confidence: Math.min(1, Number((claim.confidence * 0.68 + item.score * 0.2 + overlap.score * 0.12).toFixed(3))),
          riskLevel: claim.riskLevel,
        });
      }
    }
    return evidenceItems;
  }

  private matchPersistentRequirement(
    requirement: JDRequirement,
    retrievedClaims: RetrievedPersistentClaim[],
  ): EvidenceItem[] {
    const evidenceItems: EvidenceItem[] = [];
    const queryTerms = requirement.coreTerms.length > 0 ? requirement.coreTerms : requirement.keywords;
    for (const item of retrievedClaims) {
      if (!item.matchedRequirementIds.includes(requirement.id)) continue;
      const overlap = scoreTextOverlap(
        queryTerms.length > 0 ? queryTerms : [requirement.text],
        `${item.claim.claim}\n${item.claim.evidenceText}\n${item.claim.skills.join(" ")}`,
      );
      const strong = overlap.matchedTerms.some((term) => termWeight(term) >= 0.8);
      if (requirement.strictness === "strict" && (!strong || overlap.score < 0.1)) continue;
      evidenceItems.push({
        id: `evidence-${item.claim.id}-${requirement.id}`,
        claimId: item.claim.id,
        claimStatus: item.claim.status,
        graphEdgeIds: item.graphEdgeIds,
        experienceId: item.claim.experienceId,
        revisionId: item.claim.revisionId,
        title: String(item.claim.metadata.experienceTitle ?? item.claim.claim.slice(0, 90)),
        category: String(item.claim.metadata.category ?? item.claim.claimType ?? "other"),
        evidenceText: item.claim.evidenceText,
        skills: unique([...item.claim.skills, ...overlap.matchedTerms]).slice(0, 16),
        supportedClaims: [item.claim.claim],
        confidence: Math.min(1, Number((item.claim.confidence * 0.72 + item.score * 0.2 + overlap.score * 0.08).toFixed(3))),
        riskLevel: item.claim.riskLevel,
      });
    }
    return evidenceItems.sort((a, b) => b.confidence - a.confidence);
  }
}

function buildMissingRequirements(
  requirements: JDRequirement[],
  matchedEvidence: EvidencePack["matchedEvidence"],
  qualitySignals: EvidencePack["qualitySignals"],
): EvidencePack["missingRequirements"] {
  return matchedEvidence
    .filter((item) => item.coverage === "no_evidence")
    .map((item) => {
      const requirement = requirements.find((req) => req.id === item.requirementId);
      const signal = qualitySignals.find((sig) => sig.requirementId === item.requirementId);
      const strict = requirement?.retrievalPolicies.includes("ask_user_required") || requirement?.evidenceType === "need_user_confirmation";
      return {
        requirementId: item.requirementId,
        requirementText: requirement?.text ?? item.requirementId,
        reason: signal?.reason ?? "No supporting evidence was found.",
        recommendedAction: strict ? "ask_user" as const : requirement?.importance === "low" ? "ignore" as const : "alternative_angle" as const,
      };
    });
}

function mergeAllowedClaims(claims: AllowedClaim[]): AllowedClaim[] {
  const map = new Map<string, AllowedClaim>();
  for (const claim of claims) {
    const key = `${claim.experienceId}:${normalizeText(claim.claim)}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        ...claim,
        requirementIds: [...claim.requirementIds],
        graphEdgeIds: claim.graphEdgeIds ? [...claim.graphEdgeIds] : undefined,
      });
      continue;
    }
    existing.requirementIds = unique([...existing.requirementIds, ...claim.requirementIds]);
    existing.confidence = Math.max(existing.confidence, claim.confidence);
    existing.riskLevel = maxRisk(existing.riskLevel, claim.riskLevel);
    existing.claimId = existing.claimId ?? claim.claimId;
    existing.claimStatus = existing.claimStatus ?? claim.claimStatus;
    existing.graphEdgeIds = unique([...(existing.graphEdgeIds ?? []), ...(claim.graphEdgeIds ?? [])]);
  }
  return [...map.values()].sort((a, b) => {
    const riskDelta = riskRank(a.riskLevel) - riskRank(b.riskLevel);
    if (riskDelta !== 0) return riskDelta;
    return b.confidence - a.confidence || b.requirementIds.length - a.requirementIds.length;
  });
}

function selectDiverseEvidence(items: EvidenceItem[], limit: number): EvidenceItem[] {
  const deduped = dedupeEvidenceItems(items).sort((a, b) => b.confidence - a.confidence);
  const selected: EvidenceItem[] = [];
  const perExperience = new Map<string, number>();
  for (const item of deduped) {
    if ((perExperience.get(item.experienceId) ?? 0) >= 2) continue;
    selected.push(item);
    perExperience.set(item.experienceId, (perExperience.get(item.experienceId) ?? 0) + 1);
    if (selected.length >= limit) break;
  }
  return selected;
}

function dedupeEvidenceItems(items: EvidenceItem[]): EvidenceItem[] {
  const map = new Map<string, EvidenceItem>();
  for (const item of items) {
    const key = `${item.claimId ?? item.experienceId}:${normalizeText(item.evidenceText)}`;
    const existing = map.get(key);
    if (!existing || item.confidence > existing.confidence) map.set(key, item);
  }
  return [...map.values()];
}

function dedupeRetrievalTrace(items: EvidencePack["retrievalTrace"]): EvidencePack["retrievalTrace"] {
  const map = new Map<string, EvidencePack["retrievalTrace"][number]>();
  for (const item of items) {
    const key = `${item.source}:${item.claimId ?? item.experienceId}`;
    const existing = map.get(key);
    if (!existing || item.score > existing.score) map.set(key, item);
  }
  return [...map.values()].sort((a, b) => b.score - a.score);
}

function maxRisk(a: AllowedClaim["riskLevel"], b: AllowedClaim["riskLevel"]): AllowedClaim["riskLevel"] {
  return riskRank(a) >= riskRank(b) ? a : b;
}

function riskRank(value: AllowedClaim["riskLevel"]): number {
  if (value === "high") return 2;
  if (value === "medium") return 1;
  return 0;
}
