import { randomUUID } from "node:crypto";
import type { ProductExperience, ProductExperienceRevision } from "../../product/types.js";
import type { ClaimGraphRepository } from "./ClaimGraphRepository.js";
import { ExperienceClaimExtractor } from "./ExperienceClaimExtractor.js";
import type { LLMEvidenceService } from "./LLMEvidenceService.js";
import type { EvidenceRAGExperience, ProductEvidenceGraphEdge, ProductExperienceClaim } from "./types.js";
import { normalizeText, unique } from "./textUtils.js";

export class ClaimGraphIndexer {
  private readonly claimExtractor: ExperienceClaimExtractor;

  public constructor(
    private readonly repository: ClaimGraphRepository,
    llmEvidenceService?: LLMEvidenceService,
  ) {
    this.claimExtractor = new ExperienceClaimExtractor(llmEvidenceService);
  }

  public async indexExperience(input: {
    userId: string;
    experience: ProductExperience;
    revision: ProductExperienceRevision;
  }): Promise<{ claims: ProductExperienceClaim[]; edges: ProductEvidenceGraphEdge[] }> {
    await this.repository.markClaimsStaleForExperience(input.userId, input.experience.id);

    const experienceForExtraction: EvidenceRAGExperience = {
      ...input.experience,
      content: input.revision.content,
      structured: input.revision.structured,
    };
    const extracted = await this.claimExtractor.extract(experienceForExtraction);
    const now = new Date().toISOString();
    const claims: ProductExperienceClaim[] = extracted.map((claim, index) => ({
      ...claim,
      id: `pclaim-${randomUUID()}`,
      userId: input.userId,
      revisionId: input.revision.id,
      claimType: inferClaimType(claim.claim, input.experience.category),
      status: "active",
      metadata: {
        source: "claim_graph_indexer",
        extractorClaimId: claim.id,
        experienceTitle: input.experience.title,
        category: input.experience.category,
        index,
      },
      createdAt: now,
      updatedAt: now,
    }));

    await this.repository.upsertExperienceClaims(claims);
    const edges = buildPersistentEdges({ userId: input.userId, experienceId: input.experience.id, claims, now });
    await this.repository.replaceGraphEdgesForExperience(input.userId, input.experience.id, edges);
    return { claims, edges };
  }
}

function buildPersistentEdges(input: {
  userId: string;
  experienceId: string;
  claims: ProductExperienceClaim[];
  now: string;
}): ProductEvidenceGraphEdge[] {
  const edges: ProductEvidenceGraphEdge[] = [];
  for (const claim of input.claims) {
    edges.push({
      id: `pedge-${randomUUID()}`,
      userId: input.userId,
      sourceType: "experience",
      sourceId: input.experienceId,
      relation: "supports",
      targetType: "claim",
      targetId: claim.id,
      confidence: claim.confidence,
      metadata: { experienceId: input.experienceId, claimId: claim.id, generatedBy: "claim_graph_indexer" },
      createdAt: input.now,
      updatedAt: input.now,
    });
    for (const skill of unique(claim.skills).slice(0, 12)) {
      const skillId = `skill-${normalizeText(skill).replace(/\s+/g, "-")}`;
      edges.push({
        id: `pedge-${randomUUID()}`,
        userId: input.userId,
        sourceType: "claim",
        sourceId: claim.id,
        relation: "demonstrates",
        targetType: "skill",
        targetId: skillId,
        confidence: claim.confidence,
        metadata: { experienceId: input.experienceId, claimId: claim.id, skill, generatedBy: "claim_graph_indexer" },
        createdAt: input.now,
        updatedAt: input.now,
      });
    }
  }
  return edges;
}

function inferClaimType(claim: string, category: ProductExperience["category"]): ProductExperienceClaim["claimType"] {
  const normalized = normalizeText(claim);
  if (category === "education") return "education";
  if (category === "award") return "award";
  if (category === "skill") return "skill";
  if (/\b(built|created|designed|implemented|developed|launched|optimized|improved|reduced|increased)\b|实现|设计|开发|优化|提升|降低/.test(normalized)) return "achievement";
  if (/\b(responsible|managed|coordinated|supported|conducted)\b|负责|参与|协调|支持/.test(normalized)) return "responsibility";
  return "general";
}
