import type { EvidenceRepository } from "../../knowledge/repositories.js";
import type { Evidence } from "../../knowledge/types.js";
import type { SqliteDatabase } from "./SqliteDatabase.js";
import { numberValue, text } from "./rowUtils.js";

export class SqliteEvidenceRepository implements EvidenceRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public async getById(id: string): Promise<Evidence | null> {
    const row = this.database.get("SELECT * FROM evidences WHERE id = ?", [id]);
    return row ? this.toEvidence(row) : null;
  }

  public async getByExperienceId(experienceId: string): Promise<Evidence[]> {
    return this.database.all("SELECT * FROM evidences WHERE experience_id = ? ORDER BY created_at", [experienceId])
      .map((row) => this.toEvidence(row));
  }

  public async listByUserId(userId: string): Promise<Evidence[]> {
    return this.database.all("SELECT * FROM evidences WHERE user_id = ? ORDER BY created_at", [userId])
      .map((row) => this.toEvidence(row));
  }

  public async save(evidence: Evidence): Promise<void> {
    this.database.run(
      `INSERT OR REPLACE INTO evidences (
        id, user_id, experience_id, source_type, evidence_type, source_ref,
        excerpt, confidence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        evidence.id,
        evidence.userId,
        evidence.experienceId,
        evidence.sourceType,
        evidence.evidenceType,
        evidence.sourceRef,
        evidence.excerpt,
        evidence.confidence,
        evidence.createdAt,
      ],
    );
    this.database.save();
  }

  public async delete(id: string): Promise<void> {
    this.database.run("DELETE FROM evidences WHERE id = ?", [id]);
    this.database.save();
  }

  private toEvidence(row: Record<string, import("sql.js").SqlValue>): Evidence {
    return {
      id: text(row, "id"),
      userId: text(row, "user_id"),
      experienceId: text(row, "experience_id"),
      sourceType: text(row, "source_type") as Evidence["sourceType"],
      evidenceType: text(row, "evidence_type") as Evidence["evidenceType"],
      sourceRef: text(row, "source_ref"),
      excerpt: text(row, "excerpt"),
      confidence: numberValue(row, "confidence"),
      createdAt: text(row, "created_at"),
    };
  }
}
