import type { ProductEvidenceGraphEdge, ProductExperienceClaim } from "./types.js";

export interface ClaimGraphRepository {
  upsertExperienceClaims(claims: ProductExperienceClaim[]): Promise<ProductExperienceClaim[]>;
  listActiveClaimsByUser(userId: string, options?: { limit?: number }): Promise<ProductExperienceClaim[]>;
  markClaimsStaleForExperience(userId: string, experienceId: string): Promise<number>;
  replaceGraphEdgesForExperience(userId: string, experienceId: string, edges: ProductEvidenceGraphEdge[]): Promise<ProductEvidenceGraphEdge[]>;
  listGraphEdgesForClaims(userId: string, claimIds: string[]): Promise<ProductEvidenceGraphEdge[]>;
}

export class InMemoryClaimGraphRepository implements ClaimGraphRepository {
  private readonly claims = new Map<string, ProductExperienceClaim>();
  private readonly edges = new Map<string, ProductEvidenceGraphEdge>();

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
}
