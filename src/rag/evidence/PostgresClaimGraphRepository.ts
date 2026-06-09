import type { PostgresDatabase } from "../../persistence/postgres/PostgresDatabase.js";
import { jsonValue, optionalText, text, timestamp, type PgRow } from "../../persistence/postgres/rowUtils.js";
import type { ClaimGraphRepository } from "./ClaimGraphRepository.js";
import type {
  ClaimUsageStats,
  EvidenceOutcomeFeedback,
  EvidenceUsageRecord,
  ProductEvidenceGraphEdge,
  ProductExperienceClaim,
  RoleSpecificClaimEffectiveness,
} from "./types.js";

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

  public async recordEvidenceUsage(records: EvidenceUsageRecord[]): Promise<EvidenceUsageRecord[]> {
    for (const record of records) {
      await this.database.query(
        `INSERT INTO product_evidence_usage (
          id,user_id,generation_id,variant_id,resume_id,jd_id,target_role,role_family,requirement_id,
          claim_id,experience_id,evidence_text,generated_text,final_text,action,metadata_json,created_at,updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18)
        ON CONFLICT (id) DO UPDATE SET
          final_text=EXCLUDED.final_text,
          action=EXCLUDED.action,
          metadata_json=EXCLUDED.metadata_json,
          updated_at=EXCLUDED.updated_at`,
        [
          record.id,
          record.userId,
          record.generationId ?? null,
          record.variantId ?? null,
          record.resumeId ?? null,
          record.jdId ?? null,
          record.targetRole ?? null,
          record.roleFamily ?? null,
          record.requirementId,
          record.claimId ?? null,
          record.experienceId ?? null,
          record.evidenceText ?? null,
          record.generatedText ?? null,
          record.finalText ?? null,
          record.action,
          JSON.stringify(record.metadata),
          record.createdAt,
          record.updatedAt,
        ],
      );
    }
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
    const result = await this.database.query(
      `UPDATE product_evidence_usage
       SET action = $5, final_text = COALESCE($6, final_text), metadata_json = metadata_json || $7::jsonb, updated_at = $8
       WHERE user_id = $1
         AND ($2::text IS NULL OR generation_id = $2)
         AND ($3::text IS NULL OR variant_id = $3)
         AND ($4::text[] IS NULL OR claim_id = ANY($4))`,
      [
        input.userId,
        input.generationId ?? null,
        input.variantId ?? null,
        input.claimIds && input.claimIds.length > 0 ? input.claimIds : null,
        input.action,
        input.finalText ?? null,
        JSON.stringify(input.metadata ?? {}),
        new Date().toISOString(),
      ],
    );
    return result.rowCount;
  }

  public async listClaimUsageStats(userId: string, claimIds?: string[]): Promise<ClaimUsageStats[]> {
    const result = await this.database.query<PgRow>(
      `SELECT
        claim_id,
        MAX(experience_id) AS experience_id,
        COUNT(*) FILTER (WHERE action = 'generated')::int AS generated_count,
        COUNT(*) FILTER (WHERE action = 'accepted')::int AS accepted_count,
        COUNT(*) FILTER (WHERE action = 'edited')::int AS edited_count,
        COUNT(*) FILTER (WHERE action = 'rejected')::int AS rejected_count,
        COUNT(*) FILTER (WHERE action = 'ignored')::int AS ignored_count,
        MAX(updated_at) AS last_used_at
       FROM product_evidence_usage
       WHERE user_id = $1
         AND claim_id IS NOT NULL
         AND ($2::text[] IS NULL OR claim_id = ANY($2))
       GROUP BY claim_id`,
      [userId, claimIds && claimIds.length > 0 ? claimIds : null],
    );
    return result.rows.map(toClaimUsageStats);
  }

  public async listRoleSpecificClaimEffectiveness(userId: string, roleFamily?: string, claimIds?: string[]): Promise<RoleSpecificClaimEffectiveness[]> {
    const result = await this.database.query<PgRow>(
      `SELECT
        COALESCE(u.role_family, 'unknown') AS role_family,
        u.claim_id,
        MAX(u.experience_id) AS experience_id,
        COUNT(*) FILTER (WHERE u.action = 'generated')::int AS generated_count,
        COUNT(*) FILTER (WHERE u.action = 'accepted')::int AS accepted_count,
        COUNT(*) FILTER (WHERE u.action = 'edited')::int AS edited_count,
        COUNT(DISTINCT f.id) FILTER (WHERE f.outcome IN ('interview','offer'))::int AS outcome_positive_count
       FROM product_evidence_usage u
       LEFT JOIN product_evidence_outcome_feedback f
         ON f.user_id = u.user_id AND f.related_claim_ids_json ? u.claim_id
       WHERE u.user_id = $1
         AND u.claim_id IS NOT NULL
         AND ($2::text IS NULL OR u.role_family = $2)
         AND ($3::text[] IS NULL OR u.claim_id = ANY($3))
       GROUP BY COALESCE(u.role_family, 'unknown'), u.claim_id`,
      [userId, roleFamily ?? null, claimIds && claimIds.length > 0 ? claimIds : null],
    );
    return result.rows.map(toRoleEffectiveness);
  }

  public async recordOutcomeFeedback(feedback: EvidenceOutcomeFeedback): Promise<EvidenceOutcomeFeedback> {
    await this.database.query(
      `INSERT INTO product_evidence_outcome_feedback (
        id,user_id,generation_id,resume_id,jd_id,target_role,role_family,outcome,notes,
        related_claim_ids_json,related_experience_ids_json,metadata_json,created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13)
      ON CONFLICT (id) DO UPDATE SET
        outcome=EXCLUDED.outcome,
        notes=EXCLUDED.notes,
        related_claim_ids_json=EXCLUDED.related_claim_ids_json,
        related_experience_ids_json=EXCLUDED.related_experience_ids_json,
        metadata_json=EXCLUDED.metadata_json`,
      [
        feedback.id,
        feedback.userId,
        feedback.generationId ?? null,
        feedback.resumeId ?? null,
        feedback.jdId ?? null,
        feedback.targetRole ?? null,
        feedback.roleFamily ?? null,
        feedback.outcome,
        feedback.notes ?? null,
        JSON.stringify(feedback.relatedClaimIds),
        JSON.stringify(feedback.relatedExperienceIds),
        JSON.stringify(feedback.metadata),
        feedback.createdAt,
      ],
    );
    return feedback;
  }

  public async listOutcomeFeedback(userId: string, input: { claimIds?: string[]; experienceIds?: string[]; limit?: number } = {}): Promise<EvidenceOutcomeFeedback[]> {
    const result = await this.database.query<PgRow>(
      `SELECT * FROM product_evidence_outcome_feedback
       WHERE user_id = $1
         AND ($2::text[] IS NULL OR related_claim_ids_json ?| $2)
         AND ($3::text[] IS NULL OR related_experience_ids_json ?| $3)
       ORDER BY created_at DESC
       LIMIT $4`,
      [userId, input.claimIds && input.claimIds.length > 0 ? input.claimIds : null, input.experienceIds && input.experienceIds.length > 0 ? input.experienceIds : null, input.limit ?? 50],
    );
    return result.rows.map(toOutcomeFeedback);
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

function toClaimUsageStats(row: PgRow): ClaimUsageStats {
  const generatedCount = Number(row.generated_count ?? 0);
  const acceptedCount = Number(row.accepted_count ?? 0);
  const editedCount = Number(row.edited_count ?? 0);
  return {
    claimId: text(row, "claim_id"),
    experienceId: optionalText(row, "experience_id"),
    generatedCount,
    acceptedCount,
    editedCount,
    rejectedCount: Number(row.rejected_count ?? 0),
    ignoredCount: Number(row.ignored_count ?? 0),
    acceptanceRate: generatedCount > 0 ? acceptedCount / generatedCount : 0,
    editRate: generatedCount > 0 ? editedCount / generatedCount : 0,
    lastUsedAt: row.last_used_at ? timestamp(row, "last_used_at") : undefined,
  };
}

function toRoleEffectiveness(row: PgRow): RoleSpecificClaimEffectiveness {
  const generatedCount = Number(row.generated_count ?? 0);
  const acceptedCount = Number(row.accepted_count ?? 0);
  const editedCount = Number(row.edited_count ?? 0);
  const outcomePositiveCount = Number(row.outcome_positive_count ?? 0);
  return {
    roleFamily: text(row, "role_family"),
    claimId: text(row, "claim_id"),
    experienceId: optionalText(row, "experience_id"),
    generatedCount,
    acceptedCount,
    editedCount,
    outcomePositiveCount,
    effectivenessScore: Number(Math.min(1, (acceptedCount * 0.45 + editedCount * 0.25 + outcomePositiveCount * 0.6) / Math.max(1, generatedCount)).toFixed(3)),
  };
}

function toOutcomeFeedback(row: PgRow): EvidenceOutcomeFeedback {
  return {
    id: text(row, "id"),
    userId: text(row, "user_id"),
    generationId: optionalText(row, "generation_id"),
    resumeId: optionalText(row, "resume_id"),
    jdId: optionalText(row, "jd_id"),
    targetRole: optionalText(row, "target_role"),
    roleFamily: optionalText(row, "role_family"),
    outcome: text(row, "outcome") as EvidenceOutcomeFeedback["outcome"],
    notes: optionalText(row, "notes"),
    relatedClaimIds: jsonValue<string[]>(row, "related_claim_ids_json", []),
    relatedExperienceIds: jsonValue<string[]>(row, "related_experience_ids_json", []),
    metadata: jsonValue<Record<string, unknown>>(row, "metadata_json", {}),
    createdAt: timestamp(row, "created_at"),
  };
}
