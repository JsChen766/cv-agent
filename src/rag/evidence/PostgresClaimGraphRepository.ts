import type { PostgresDatabase } from "../../persistence/postgres/PostgresDatabase.js";
import { jsonValue, optionalText, text, timestamp, type PgRow } from "../../persistence/postgres/rowUtils.js";
import type { ClaimGraphRepository } from "./ClaimGraphRepository.js";
import type { ProductEvidenceGraphEdge, ProductExperienceClaim } from "./types.js";

type Db = Pick<PostgresDatabase, "query">;

export class PostgresClaimGraphRepository implements ClaimGraphRepository {
  public constructor(private readonly database: Db) {}

  public async upsertExperienceClaims(claims: ProductExperienceClaim[]): Promise<ProductExperienceClaim[]> {
    for (const claim of claims) {
      await this.database.query(
        `INSERT INTO product_experience_claim (
          id,user_id,experience_id,revision_id,claim,claim_type,evidence_text,skills_json,
          confidence,risk_level,status,metadata_json,created_at,updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12::jsonb,$13,$14)
        ON CONFLICT (id) DO UPDATE SET
          claim=EXCLUDED.claim,
          claim_type=EXCLUDED.claim_type,
          evidence_text=EXCLUDED.evidence_text,
          skills_json=EXCLUDED.skills_json,
          confidence=EXCLUDED.confidence,
          risk_level=EXCLUDED.risk_level,
          status=EXCLUDED.status,
          metadata_json=EXCLUDED.metadata_json,
          updated_at=EXCLUDED.updated_at`,
        [
          claim.id,
          claim.userId,
          claim.experienceId,
          claim.revisionId ?? null,
          claim.claim,
          claim.claimType,
          claim.evidenceText,
          JSON.stringify(claim.skills),
          claim.confidence,
          claim.riskLevel,
          claim.status,
          JSON.stringify(claim.metadata),
          claim.createdAt,
          claim.updatedAt,
        ],
      );
    }
    return claims;
  }

  public async listActiveClaimsByUser(userId: string, options: { limit?: number } = {}): Promise<ProductExperienceClaim[]> {
    const result = await this.database.query<PgRow>(
      `SELECT * FROM product_experience_claim
       WHERE user_id = $1 AND status = 'active'
       ORDER BY confidence DESC, created_at DESC
       LIMIT $2`,
      [userId, options.limit ?? 300],
    );
    return result.rows.map(toExperienceClaim);
  }

  public async markClaimsStaleForExperience(userId: string, experienceId: string): Promise<number> {
    const result = await this.database.query(
      `UPDATE product_experience_claim
       SET status = 'stale', updated_at = $3
       WHERE user_id = $1 AND experience_id = $2 AND status = 'active'`,
      [userId, experienceId, new Date().toISOString()],
    );
    return result.rowCount;
  }

  public async replaceGraphEdgesForExperience(userId: string, experienceId: string, edges: ProductEvidenceGraphEdge[]): Promise<ProductEvidenceGraphEdge[]> {
    await this.database.query(
      `DELETE FROM product_evidence_graph_edge WHERE user_id = $1 AND metadata_json->>'experienceId' = $2`,
      [userId, experienceId],
    );
    for (const edge of edges) {
      await this.database.query(
        `INSERT INTO product_evidence_graph_edge (
          id,user_id,source_type,source_id,relation,target_type,target_id,confidence,metadata_json,created_at,updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
        ON CONFLICT (id) DO UPDATE SET
          source_type=EXCLUDED.source_type,
          source_id=EXCLUDED.source_id,
          relation=EXCLUDED.relation,
          target_type=EXCLUDED.target_type,
          target_id=EXCLUDED.target_id,
          confidence=EXCLUDED.confidence,
          metadata_json=EXCLUDED.metadata_json,
          updated_at=EXCLUDED.updated_at`,
        [
          edge.id,
          edge.userId,
          edge.sourceType,
          edge.sourceId,
          edge.relation,
          edge.targetType,
          edge.targetId,
          edge.confidence,
          JSON.stringify(edge.metadata),
          edge.createdAt,
          edge.updatedAt,
        ],
      );
    }
    return edges;
  }

  public async listGraphEdgesForClaims(userId: string, claimIds: string[]): Promise<ProductEvidenceGraphEdge[]> {
    if (claimIds.length === 0) return [];
    const result = await this.database.query<PgRow>(
      `SELECT * FROM product_evidence_graph_edge
       WHERE user_id = $1 AND (source_id = ANY($2) OR target_id = ANY($2))`,
      [userId, Array.from(new Set(claimIds))],
    );
    return result.rows.map(toGraphEdge);
  }
}

function toExperienceClaim(row: PgRow): ProductExperienceClaim {
  return {
    id: text(row, "id"),
    userId: text(row, "user_id"),
    experienceId: text(row, "experience_id"),
    revisionId: optionalText(row, "revision_id"),
    claim: text(row, "claim"),
    claimType: text(row, "claim_type") as ProductExperienceClaim["claimType"],
    evidenceText: text(row, "evidence_text"),
    skills: jsonValue<string[]>(row, "skills_json", []),
    confidence: Number(row.confidence),
    riskLevel: text(row, "risk_level") as ProductExperienceClaim["riskLevel"],
    status: text(row, "status") as ProductExperienceClaim["status"],
    metadata: jsonValue<Record<string, unknown>>(row, "metadata_json", {}),
    createdAt: timestamp(row, "created_at"),
    updatedAt: timestamp(row, "updated_at"),
  };
}

function toGraphEdge(row: PgRow): ProductEvidenceGraphEdge {
  return {
    id: text(row, "id"),
    userId: text(row, "user_id"),
    sourceType: text(row, "source_type") as ProductEvidenceGraphEdge["sourceType"],
    sourceId: text(row, "source_id"),
    relation: text(row, "relation") as ProductEvidenceGraphEdge["relation"],
    targetType: text(row, "target_type") as ProductEvidenceGraphEdge["targetType"],
    targetId: text(row, "target_id"),
    confidence: Number(row.confidence),
    metadata: jsonValue<Record<string, unknown>>(row, "metadata_json", {}),
    createdAt: timestamp(row, "created_at"),
    updatedAt: timestamp(row, "updated_at"),
  };
}
