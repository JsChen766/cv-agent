import type { EvidenceRepository } from "../../knowledge/repositories.js";
import type { Evidence } from "../../knowledge/types.js";
import type { PostgresDatabase } from "./PostgresDatabase.js";
import { jsonValue, numberValue, optionalText, text, timestamp } from "./rowUtils.js";

export class PostgresEvidenceRepository implements EvidenceRepository {
  public constructor(private readonly database: Pick<PostgresDatabase, "query">) {}

  public async getById(id: string): Promise<Evidence | null> {
    const result = await this.database.query("SELECT * FROM evidences WHERE id = $1", [id]);
    return result.rows[0] ? this.toEvidence(result.rows[0]) : null;
  }

  public async getByIdForUser(userId: string, id: string): Promise<Evidence | null> {
    const result = await this.database.query("SELECT * FROM evidences WHERE user_id = $1 AND id = $2", [userId, id]);
    return result.rows[0] ? this.toEvidence(result.rows[0]) : null;
  }

  public async getByExperienceId(experienceId: string): Promise<Evidence[]> {
    const result = await this.database.query("SELECT * FROM evidences WHERE experience_id = $1 ORDER BY created_at", [experienceId]);
    return result.rows.map((row) => this.toEvidence(row));
  }

  public async listByUserId(userId: string): Promise<Evidence[]> {
    const result = await this.database.query("SELECT * FROM evidences WHERE user_id = $1 ORDER BY created_at", [userId]);
    return result.rows.map((row) => this.toEvidence(row));
  }

  public async save(evidence: Evidence): Promise<void> {
    await this.database.query(
      `INSERT INTO evidences (
        id, user_id, experience_id, source_document_id, source_type, evidence_type, source_ref,
        excerpt, confidence, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
      ON CONFLICT (id) DO UPDATE SET
        experience_id = EXCLUDED.experience_id,
        source_document_id = EXCLUDED.source_document_id,
        source_type = EXCLUDED.source_type,
        evidence_type = EXCLUDED.evidence_type,
        source_ref = EXCLUDED.source_ref,
        excerpt = EXCLUDED.excerpt,
        confidence = EXCLUDED.confidence,
        metadata = EXCLUDED.metadata`,
      [
        evidence.id,
        evidence.userId,
        evidence.experienceId,
        evidence.sourceDocumentId ?? null,
        evidence.sourceType,
        evidence.evidenceType,
        evidence.sourceRef,
        evidence.excerpt,
        evidence.confidence,
        JSON.stringify(evidence.metadata ?? {}),
        evidence.createdAt,
      ],
    );
  }

  public async delete(id: string): Promise<void> {
    await this.database.query("DELETE FROM evidences WHERE id = $1", [id]);
  }

  public async deleteForUser(userId: string, id: string): Promise<void> {
    await this.database.query("DELETE FROM evidences WHERE user_id = $1 AND id = $2", [userId, id]);
  }

  private toEvidence(row: Record<string, unknown>): Evidence {
    return {
      id: text(row, "id"),
      userId: text(row, "user_id"),
      experienceId: text(row, "experience_id"),
      sourceType: text(row, "source_type") as Evidence["sourceType"],
      evidenceType: text(row, "evidence_type") as Evidence["evidenceType"],
      sourceRef: text(row, "source_ref"),
      excerpt: text(row, "excerpt"),
      confidence: numberValue(row, "confidence"),
      ...(optionalText(row, "source_document_id") ? { sourceDocumentId: optionalText(row, "source_document_id") } : {}),
      metadata: jsonValue<Record<string, unknown>>(row, "metadata", {}),
      createdAt: timestamp(row, "created_at"),
    };
  }
}
