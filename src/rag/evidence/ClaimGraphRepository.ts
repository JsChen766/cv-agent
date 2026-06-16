import type {
  ClaimUsageStats,
  EvidenceOutcomeFeedback,
  EvidenceUsageRecord,
  ProductEvidenceGraphEdge,
  ProductExperienceClaim,
  RoleSpecificClaimEffectiveness,
} from "./types.js";

export interface ClaimGraphRepository {
  upsertExperienceClaims(claims: ProductExperienceClaim[]): Promise<ProductExperienceClaim[]>;
  listActiveClaimsByUser(userId: string, options?: { limit?: number }): Promise<ProductExperienceClaim[]>;
  markClaimsStaleForExperience(userId: string, experienceId: string): Promise<number>;
  replaceGraphEdgesForExperience(userId: string, experienceId: string, edges: ProductEvidenceGraphEdge[]): Promise<ProductEvidenceGraphEdge[]>;
  listGraphEdgesForClaims(userId: string, claimIds: string[]): Promise<ProductEvidenceGraphEdge[]>;
  recordEvidenceUsage(records: EvidenceUsageRecord[]): Promise<EvidenceUsageRecord[]>;
  updateEvidenceUsageAction(input: {
    userId: string;
    generationId?: string;
    variantId?: string;
    claimIds?: string[];
    action: EvidenceUsageRecord["action"];
    finalText?: string;
    metadata?: Record<string, unknown>;
  }): Promise<number>;
  appendEvidenceUsageDecision(input: {
    userId: string;
    generationId?: string;
    variantId?: string;
    claimIds?: string[];
    action: EvidenceUsageRecord["action"];
    finalText?: string;
    metadata?: Record<string, unknown>;
    decisionIdPrefix: string;
  }): Promise<number>;
  listClaimUsageStats(userId: string, claimIds?: string[]): Promise<ClaimUsageStats[]>;
  listRoleSpecificClaimEffectiveness(userId: string, roleFamily?: string, claimIds?: string[]): Promise<RoleSpecificClaimEffectiveness[]>;
  recordOutcomeFeedback(feedback: EvidenceOutcomeFeedback): Promise<EvidenceOutcomeFeedback>;
  listOutcomeFeedback(userId: string, input?: { claimIds?: string[]; experienceIds?: string[]; limit?: number }): Promise<EvidenceOutcomeFeedback[]>;
}

export class InMemoryClaimGraphRepository implements ClaimGraphRepository {
  private readonly claims = new Map<string, ProductExperienceClaim>();
  private readonly edges = new Map<string, ProductEvidenceGraphEdge>();
  private readonly usage = new Map<string, EvidenceUsageRecord>();
  private readonly feedback = new Map<string, EvidenceOutcomeFeedback>();

  public async upsertExperienceClaims(claims: ProductExperienceClaim[]): Promise<ProductExperienceClaim[]> {
    for (const claim of claims) this.claims.set(claim.id, claim);
    return claims;
  }

  public async listActiveClaimsByUser(userId: string, options: { limit?: number } = {}): Promise<ProductExperienceClaim[]> {
    return Array.from(this.claims.values())
      .filter((claim) => claim.userId === userId && claim.status === "active")
      .sort((a, b) => b.confidence - a.confidence || b.createdAt.localeCompare(a.createdAt))
      .slice(0, options.limit ?? 300);
  }

  public async markClaimsStaleForExperience(userId: string, experienceId: string): Promise<number> {
    let count = 0;
    for (const [id, claim] of this.claims.entries()) {
      if (claim.userId !== userId || claim.experienceId !== experienceId || claim.status !== "active") continue;
      this.claims.set(id, { ...claim, status: "stale", updatedAt: new Date().toISOString() });
      count++;
    }
    return count;
  }

  public async replaceGraphEdgesForExperience(userId: string, experienceId: string, edges: ProductEvidenceGraphEdge[]): Promise<ProductEvidenceGraphEdge[]> {
    for (const [id, edge] of Array.from(this.edges.entries())) {
      if (edge.userId === userId && edge.metadata.experienceId === experienceId) {
        this.edges.delete(id);
      }
    }
    for (const edge of edges) this.edges.set(edge.id, edge);
    return edges;
  }

  public async listGraphEdgesForClaims(userId: string, claimIds: string[]): Promise<ProductEvidenceGraphEdge[]> {
    if (claimIds.length === 0) return [];
    const ids = new Set(claimIds);
    return Array.from(this.edges.values())
      .filter((edge) => edge.userId === userId && (ids.has(edge.sourceId) || ids.has(edge.targetId)));
  }

  public async recordEvidenceUsage(records: EvidenceUsageRecord[]): Promise<EvidenceUsageRecord[]> {
    for (const record of records) this.usage.set(record.id, record);
    return records;
  }

  public async updateEvidenceUsageAction(input: {
    userId: string;
    generationId?: string;
    variantId?: string;
    claimIds?: string[];
    action: EvidenceUsageRecord["action"];
    finalText?: string;
    metadata?: Record<string, unknown>;
  }): Promise<number> {
    const claimSet = input.claimIds ? new Set(input.claimIds) : undefined;
    let count = 0;
    const now = new Date().toISOString();
    for (const [id, record] of this.usage.entries()) {
      if (record.userId !== input.userId) continue;
      if (input.generationId && record.generationId !== input.generationId) continue;
      if (input.variantId && record.variantId !== input.variantId) continue;
      if (claimSet && (!record.claimId || !claimSet.has(record.claimId))) continue;
      this.usage.set(id, {
        ...record,
        action: input.action,
        finalText: input.finalText ?? record.finalText,
        metadata: { ...record.metadata, ...(input.metadata ?? {}) },
        updatedAt: now,
      });
      count++;
    }
    return count;
  }

  public async appendEvidenceUsageDecision(input: {
    userId: string;
    generationId?: string;
    variantId?: string;
    claimIds?: string[];
    action: EvidenceUsageRecord["action"];
    finalText?: string;
    metadata?: Record<string, unknown>;
    decisionIdPrefix: string;
  }): Promise<number> {
    const claimSet = input.claimIds ? new Set(input.claimIds) : undefined;
    const sourceRecords = Array.from(this.usage.values()).filter((record) => {
      if (record.userId !== input.userId || record.action !== "generated") return false;
      if (input.generationId && record.generationId !== input.generationId) return false;
      if (input.variantId && record.variantId !== input.variantId) return false;
      if (claimSet && (!record.claimId || !claimSet.has(record.claimId))) return false;
      return true;
    });
    const now = new Date().toISOString();
    let count = 0;
    for (const [index, record] of sourceRecords.entries()) {
      const decision: EvidenceUsageRecord = {
        ...record,
        id: `${input.decisionIdPrefix}-${index + 1}`,
        action: input.action,
        finalText: input.finalText ?? record.finalText,
        metadata: { ...record.metadata, ...(input.metadata ?? {}), sourceUsageId: record.id },
        createdAt: now,
        updatedAt: now,
      };
      this.usage.set(decision.id, decision);
      count++;
    }
    if (count === 0 && claimSet) {
      for (const [index, claimId] of Array.from(claimSet).entries()) {
        const claim = this.claims.get(claimId);
        const decision: EvidenceUsageRecord = {
          id: `${input.decisionIdPrefix}-fallback-${index + 1}`,
          userId: input.userId,
          generationId: input.generationId,
          variantId: input.variantId,
          requirementId: "unmapped",
          claimId,
          experienceId: claim?.experienceId,
          evidenceText: claim?.evidenceText,
          action: input.action,
          finalText: input.finalText,
          metadata: { ...(input.metadata ?? {}), fallbackDecision: true },
          createdAt: now,
          updatedAt: now,
        };
        this.usage.set(decision.id, decision);
        count++;
      }
    }
    return count;
  }

  public async listClaimUsageStats(userId: string, claimIds?: string[]): Promise<ClaimUsageStats[]> {
    const claimSet = claimIds ? new Set(claimIds) : undefined;
    const grouped = new Map<string, EvidenceUsageRecord[]>();
    for (const record of this.usage.values()) {
      if (record.userId !== userId || !record.claimId) continue;
      if (claimSet && !claimSet.has(record.claimId)) continue;
      const records = grouped.get(record.claimId) ?? [];
      records.push(record);
      grouped.set(record.claimId, records);
    }
    return Array.from(grouped.entries()).map(([claimId, records]) => toClaimUsageStats(claimId, records));
  }

  public async listRoleSpecificClaimEffectiveness(userId: string, roleFamily?: string, claimIds?: string[]): Promise<RoleSpecificClaimEffectiveness[]> {
    const claimSet = claimIds ? new Set(claimIds) : undefined;
    const grouped = new Map<string, EvidenceUsageRecord[]>();
    for (const record of this.usage.values()) {
      if (record.userId !== userId || !record.claimId) continue;
      if (roleFamily && record.roleFamily !== roleFamily) continue;
      if (claimSet && !claimSet.has(record.claimId)) continue;
      const key = `${record.roleFamily ?? "unknown"}:${record.claimId}`;
      const records = grouped.get(key) ?? [];
      records.push(record);
      grouped.set(key, records);
    }
    return Array.from(grouped.entries()).map(([key, records]) => {
      const [role, claimId] = key.split(":");
      return toRoleEffectiveness(role, claimId, records, Array.from(this.feedback.values()));
    });
  }

  public async recordOutcomeFeedback(feedback: EvidenceOutcomeFeedback): Promise<EvidenceOutcomeFeedback> {
    this.feedback.set(feedback.id, feedback);
    return feedback;
  }

  public async listOutcomeFeedback(userId: string, input: { claimIds?: string[]; experienceIds?: string[]; limit?: number } = {}): Promise<EvidenceOutcomeFeedback[]> {
    const claimSet = input.claimIds ? new Set(input.claimIds) : undefined;
    const expSet = input.experienceIds ? new Set(input.experienceIds) : undefined;
    return Array.from(this.feedback.values())
      .filter((item) => item.userId === userId)
      .filter((item) => !claimSet || item.relatedClaimIds.some((id) => claimSet.has(id)))
      .filter((item) => !expSet || item.relatedExperienceIds.some((id) => expSet.has(id)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, input.limit ?? 50);
  }
}

function toClaimUsageStats(claimId: string, records: EvidenceUsageRecord[]): ClaimUsageStats {
  const generatedCount = records.filter((record) => record.action === "generated").length;
  const acceptedCount = records.filter((record) => record.action === "accepted").length;
  const editedCount = records.filter((record) => record.action === "edited").length;
  const rejectedCount = records.filter((record) => record.action === "rejected").length;
  const ignoredCount = records.filter((record) => record.action === "ignored").length;
  const lastUsedAt = records.map((record) => record.updatedAt).sort().at(-1);
  return {
    claimId,
    experienceId: records.find((record) => record.experienceId)?.experienceId,
    generatedCount,
    acceptedCount,
    editedCount,
    rejectedCount,
    ignoredCount,
    acceptanceRate: generatedCount > 0 ? acceptedCount / generatedCount : 0,
    editRate: generatedCount > 0 ? editedCount / generatedCount : 0,
    lastUsedAt,
  };
}

function toRoleEffectiveness(roleFamily: string, claimId: string, records: EvidenceUsageRecord[], feedback: EvidenceOutcomeFeedback[]): RoleSpecificClaimEffectiveness {
  const generatedCount = records.filter((record) => record.action === "generated").length;
  const acceptedCount = records.filter((record) => record.action === "accepted").length;
  const editedCount = records.filter((record) => record.action === "edited").length;
  const outcomePositiveCount = feedback.filter((item) => item.roleFamily === roleFamily && item.relatedClaimIds.includes(claimId) && (item.outcome === "interview" || item.outcome === "offer")).length;
  const effectivenessScore = Math.min(1, (acceptedCount * 0.45 + editedCount * 0.25 + outcomePositiveCount * 0.6) / Math.max(1, generatedCount));
  return {
    roleFamily,
    claimId,
    experienceId: records.find((record) => record.experienceId)?.experienceId,
    generatedCount,
    acceptedCount,
    editedCount,
    outcomePositiveCount,
    effectivenessScore: Number(effectivenessScore.toFixed(3)),
  };
}
