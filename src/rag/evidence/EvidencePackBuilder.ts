import type {
  AllowedClaim,
  EvidenceItem,
  EvidencePack,
  ExperienceClaim,
  JDRequirement,
  RetrievedExperience,
  RetrievedPersistentClaim,
} from "./types.js";
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

    const pack = this.buildCore({
      version: "evidence-rag-v1.5",
      requirements: input.requirements,
      retrievalTrace: this.traceBuilder.retrievalTrace(input.retrieved),
      matchRequirement: (requirement) => this.matchRequirement(requirement, input.retrieved, claimsByExperience),
    });
    return pack;
  }

  public buildFromPersistentClaims(input: {
    requirements: JDRequirement[];
    retrievedClaims: RetrievedPersistentClaim[];
  }): EvidencePack {
    return this.buildCore({
      version: "evidence-rag-v2",
      requirements: input.requirements,
      retrievalTrace: this.traceBuilder.persistentClaimTrace(input.retrievedClaims),
      matchRequirement: (requirement) => this.matchPersistentRequirement(requirement, input.retrievedClaims),
    });
  }

  public mergePersistentAndDynamic(persistent: EvidencePack, dynamic: EvidencePack): EvidencePack {
    const allowedClaims = mergeAllowedClaims([...persistent.allowedClaims, ...dynamic.allowedClaims]).slice(0, 60);
    const matchedEvidence = persistent.jdRequirements.map((requirement) => {
      const persistentMatch = persistent.matchedEvidence.find((item) => item.requirementId === requirement.id);
      const dynamicMatch = dynamic.matchedEvidence.find((item) => item.requirementId === requirement.id);
      const evidenceItems = dedupeEvidenceItems([
        ...(persistentMatch?.evidenceItems ?? []),
        ...(dynamicMatch?.evidenceItems ?? []),
      ]).slice(0, 6);
      const scored = this.qualityScorer.score(requirement, evidenceItems);
      return {
        requirementId: requirement.id,
        evidenceItems,
        coverage: scored.coverage,
        recommendedAction: scored.recommendedAction,
      };
    });
    const qualitySignals = persistent.jdRequirements.map((requirement) => {
      const match = matchedEvidence.find((item) => item.requirementId === requirement.id);
      return this.qualityScorer.score(requirement, match?.evidenceItems ?? []).signal;
    });
    const missingRequirements = matchedEvidence
      .filter((item) => item.coverage === "no_evidence")
      .map((item) => {
        const requirement = persistent.jdRequirements.find((req) => req.id === item.requirementId);
        const signal = qualitySignals.find((sig) => sig.requirementId === item.requirementId);
        return {
          requirementId: item.requirementId,
          requirementText: requirement?.text ?? item.requirementId,
          reason: signal?.reason ?? "No supporting evidence was found.",
          recommendedAction: "alternative_angle" as const,
        };
      });
    const evidenceItems = dedupeEvidenceItems(matchedEvidence.flatMap((item) => item.evidenceItems));
    return {
      version: "evidence-rag-v2",
      jdRequirements: persistent.jdRequirements,
      matchedEvidence,
      allowedClaims,
      missingRequirements,
      retrievalTrace: [...persistent.retrievalTrace, ...dynamic.retrievalTrace],
      qualitySignals,
      graphLinks: this.graphBuilder.build({
        requirements: persistent.jdRequirements,
        allowedClaims,
        evidenceItems,
      }),
      usageTrace: this.traceBuilder.usageTrace(persistent.jdRequirements, allowedClaims),
    };
  }

  private buildCore(input: {
    version: EvidencePack["version"];
    requirements: JDRequirement[];
    retrievalTrace: EvidencePack["retrievalTrace"];
    matchRequirement: (requirement: JDRequirement) => EvidenceItem[];
  }): EvidencePack {
    const allEvidenceItems: EvidenceItem[] = [];
    const allowedClaims: AllowedClaim[] = [];
    const matchedEvidence: EvidencePack["matchedEvidence"] = [];
    const missingRequirements: EvidencePack["missingRequirements"] = [];
    const qualitySignals: EvidencePack["qualitySignals"] = [];

    for (const requirement of input.requirements) {
      const evidenceItems = input.matchRequirement(requirement);
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
            id: item.claimId ?? `allowed-${item.id}-${requirement.id}-${allowedClaims.length + 1}`,
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

    const mergedAllowedClaims = mergeAllowedClaims(allowedClaims).slice(0, 40);
    const uniqueEvidenceItems = dedupeEvidenceItems(allEvidenceItems);
    return {
      version: input.version,
      jdRequirements: input.requirements,
      matchedEvidence,
      allowedClaims: mergedAllowedClaims,
      missingRequirements,
      retrievalTrace: input.retrievalTrace,
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

  private matchPersistentRequirement(
    requirement: JDRequirement,
    retrievedClaims: RetrievedPersistentClaim[],
  ): EvidenceItem[] {
    const evidenceItems: EvidenceItem[] = [];
    for (const item of retrievedClaims) {
      if (!item.matchedRequirementIds.includes(requirement.id)) continue;
      const overlap = scoreTextOverlap(requirement.keywords.length > 0 ? requirement.keywords : [requirement.text], `${item.claim.claim}\n${item.claim.evidenceText}\n${item.claim.skills.join(" ")}`);
      evidenceItems.push({
        id: `evidence-${item.claim.id}-${requirement.id}`,
        claimId: item.claim.id,
        claimStatus: item.claim.status,
        graphEdgeIds: item.graphEdgeIds,
        experienceId: item.claim.experienceId,
        revisionId: item.claim.revisionId,
        title: item.claim.claim.slice(0, 90),
        category: String(item.claim.metadata.category ?? item.claim.claimType ?? "other"),
        evidenceText: item.claim.evidenceText,
        skills: unique([...item.claim.skills, ...overlap.matchedTerms]).slice(0, 12),
        supportedClaims: [item.claim.claim],
        confidence: Math.min(1, Number((item.claim.confidence * 0.8 + Math.max(item.score, overlap.score) * 0.2).toFixed(3))),
        riskLevel: item.claim.riskLevel,
      });
    }
    return dedupeEvidenceItems(evidenceItems)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 6);
  }
}

function mergeAllowedClaims(claims: AllowedClaim[]): AllowedClaim[] {
  const map = new Map<string, AllowedClaim>();
  for (const claim of claims) {
    const key = `${claim.experienceId}:${claim.claim.toLowerCase().replace(/\W+/g, " ").trim()}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...claim, requirementIds: [...claim.requirementIds], graphEdgeIds: claim.graphEdgeIds ? [...claim.graphEdgeIds] : undefined });
      continue;
    }
    existing.requirementIds = unique([...existing.requirementIds, ...claim.requirementIds]);
    existing.confidence = Math.max(existing.confidence, claim.confidence);
    existing.riskLevel = existing.riskLevel === "high" || claim.riskLevel === "high" ? "high" : existing.riskLevel === "medium" || claim.riskLevel === "medium" ? "medium" : "low";
    existing.claimId = existing.claimId ?? claim.claimId;
    existing.claimStatus = existing.claimStatus ?? claim.claimStatus;
    existing.graphEdgeIds = unique([...(existing.graphEdgeIds ?? []), ...(claim.graphEdgeIds ?? [])]);
  }
  return [...map.values()].sort((a, b) => b.confidence - a.confidence);
}

function dedupeEvidenceItems(items: EvidenceItem[]): EvidenceItem[] {
  const seen = new Set<string>();
  const result: EvidenceItem[] = [];
  for (const item of items) {
    const key = `${item.claimId ?? item.experienceId}:${item.evidenceText.toLowerCase().replace(/\W+/g, " ").trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}
