import type { ExperienceRepository } from "../../knowledge/repositories.js";
import type { Experience } from "../../knowledge/types.js";
import type { PostgresDatabase } from "./PostgresDatabase.js";
import { jsonValue, numberValue, optionalText, text, timestamp } from "./rowUtils.js";

export class PostgresExperienceRepository implements ExperienceRepository {
  public constructor(private readonly database: Pick<PostgresDatabase, "query">) {}

  // Legacy interface method. Do not expose through backend/API.
  // Prefer getByIdForUser.
  public async getById(id: string): Promise<Experience | null> {
    const result = await this.database.query("SELECT * FROM experiences WHERE id = $1", [id]);
    return result.rows[0] ? this.toExperience(result.rows[0]) : null;
  }

  public async getByIdForUser(userId: string, id: string): Promise<Experience | null> {
    const result = await this.database.query("SELECT * FROM experiences WHERE user_id = $1 AND id = $2", [userId, id]);
    return result.rows[0] ? this.toExperience(result.rows[0]) : null;
  }

  public async list(): Promise<Experience[]> {
    const result = await this.database.query("SELECT * FROM experiences ORDER BY created_at");
    return result.rows.map((row) => this.toExperience(row));
  }

  public async listByUserId(userId: string): Promise<Experience[]> {
    const result = await this.database.query("SELECT * FROM experiences WHERE user_id = $1 ORDER BY created_at", [userId]);
    return result.rows.map((row) => this.toExperience(row));
  }

  public async save(experience: Experience): Promise<void> {
    await this.database.query(
      `INSERT INTO experiences (
        id, user_id, type, organization, role, summary, time_range, star,
        evidence_ids, skill_ids, confidence, source_document_id, metadata, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13::jsonb, $14, $15)
      ON CONFLICT (id) DO UPDATE SET
        type = EXCLUDED.type,
        organization = EXCLUDED.organization,
        role = EXCLUDED.role,
        summary = EXCLUDED.summary,
        time_range = EXCLUDED.time_range,
        star = EXCLUDED.star,
        evidence_ids = EXCLUDED.evidence_ids,
        skill_ids = EXCLUDED.skill_ids,
        confidence = EXCLUDED.confidence,
        source_document_id = EXCLUDED.source_document_id,
        metadata = EXCLUDED.metadata,
        updated_at = EXCLUDED.updated_at`,
      [
        experience.id,
        experience.userId,
        experience.type,
        experience.organization,
        experience.role,
        experience.summary,
        JSON.stringify(experience.timeRange),
        JSON.stringify(experience.star),
        JSON.stringify(experience.evidenceIds),
        JSON.stringify(experience.skillIds),
        experience.confidence,
        experience.sourceDocumentId ?? null,
        JSON.stringify(experience.metadata ?? {}),
        experience.createdAt,
        experience.updatedAt,
      ],
    );
  }

  // Legacy interface method. Do not expose through backend/API.
  // Prefer deleteForUser.
  public async delete(id: string): Promise<void> {
    await this.database.query("DELETE FROM experiences WHERE id = $1", [id]);
  }

  public async deleteForUser(userId: string, id: string): Promise<void> {
    await this.database.query("DELETE FROM experiences WHERE user_id = $1 AND id = $2", [userId, id]);
  }

  private toExperience(row: Record<string, unknown>): Experience {
    return {
      id: text(row, "id"),
      userId: text(row, "user_id"),
      type: text(row, "type") as Experience["type"],
      organization: text(row, "organization"),
      role: text(row, "role"),
      summary: text(row, "summary"),
      timeRange: jsonValue(row, "time_range"),
      star: jsonValue(row, "star"),
      evidenceIds: jsonValue(row, "evidence_ids"),
      skillIds: jsonValue(row, "skill_ids"),
      confidence: numberValue(row, "confidence"),
      ...(optionalText(row, "source_document_id") ? { sourceDocumentId: optionalText(row, "source_document_id") } : {}),
      metadata: jsonValue<Record<string, unknown>>(row, "metadata", {}),
      createdAt: timestamp(row, "created_at"),
      updatedAt: timestamp(row, "updated_at"),
    };
  }
}
