import type { GeneratedArtifactRepository } from "../../knowledge/repositories.js";
import type { GeneratedArtifact } from "../../knowledge/types.js";
import type { PostgresDatabase } from "./PostgresDatabase.js";
import { jsonValue, optionalText, text, timestamp, type PgRow } from "./rowUtils.js";

export class PostgresGeneratedArtifactRepository implements GeneratedArtifactRepository {
  public constructor(private readonly database: Pick<PostgresDatabase, "query">) {}

  // Legacy interface method. Do not expose through backend/API.
  // Prefer getByIdForUser.
  public async getById(id: string): Promise<GeneratedArtifact | null> {
    const result = await this.database.query<PgRow>(
      "SELECT * FROM generated_artifacts WHERE id = $1 LIMIT 1",
      [id],
    );
    return result.rows[0] ? toGeneratedArtifact(result.rows[0]) : null;
  }

  public async getByIdForUser(userId: string, id: string): Promise<GeneratedArtifact | null> {
    const result = await this.database.query<PgRow>(
      "SELECT * FROM generated_artifacts WHERE user_id = $1 AND id = $2 LIMIT 1",
      [userId, id],
    );
    return result.rows[0] ? toGeneratedArtifact(result.rows[0]) : null;
  }

  public async getByExperienceId(experienceId: string): Promise<GeneratedArtifact[]> {
    const result = await this.database.query<PgRow>(
      "SELECT * FROM generated_artifacts WHERE source_experience_ids @> $1::jsonb ORDER BY created_at ASC",
      [JSON.stringify([experienceId])],
    );
    return result.rows.map(toGeneratedArtifact);
  }

  public async listByUserId(userId: string): Promise<GeneratedArtifact[]> {
    const result = await this.database.query<PgRow>(
      "SELECT * FROM generated_artifacts WHERE user_id = $1 ORDER BY created_at ASC",
      [userId],
    );
    return result.rows.map(toGeneratedArtifact);
  }

  public async save(artifact: GeneratedArtifact): Promise<void> {
    await this.database.query(
      `INSERT INTO generated_artifacts (
        id, user_id, type, content, source_experience_ids, source_evidence_ids,
        matched_skill_ids, target_jd_id, target_requirement_ids, target_role,
        scores, status, metadata, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9::jsonb, $10,
        $11::jsonb, $12, $13::jsonb, $14, $15
      )
      ON CONFLICT (id) DO UPDATE SET
        type = EXCLUDED.type,
        content = EXCLUDED.content,
        source_experience_ids = EXCLUDED.source_experience_ids,
        source_evidence_ids = EXCLUDED.source_evidence_ids,
        matched_skill_ids = EXCLUDED.matched_skill_ids,
        target_jd_id = EXCLUDED.target_jd_id,
        target_requirement_ids = EXCLUDED.target_requirement_ids,
        target_role = EXCLUDED.target_role,
        scores = EXCLUDED.scores,
        status = EXCLUDED.status,
        metadata = EXCLUDED.metadata,
        updated_at = EXCLUDED.updated_at`,
      [
        artifact.id,
        artifact.userId,
        artifact.type,
        artifact.content,
        JSON.stringify(artifact.sourceExperienceIds),
        JSON.stringify(artifact.sourceEvidenceIds),
        JSON.stringify(artifact.matchedSkillIds),
        artifact.targetJDId,
        JSON.stringify(artifact.targetRequirementIds),
        artifact.targetRole,
        JSON.stringify(artifact.scores),
        artifact.status,
        JSON.stringify({}),
        artifact.createdAt,
        artifact.updatedAt,
      ],
    );
  }

  // Legacy interface method. Do not expose through backend/API.
  // Prefer deleteForUser.
  public async delete(id: string): Promise<void> {
    await this.database.query("DELETE FROM generated_artifacts WHERE id = $1", [id]);
  }

  public async deleteForUser(userId: string, id: string): Promise<void> {
    await this.database.query("DELETE FROM generated_artifacts WHERE user_id = $1 AND id = $2", [userId, id]);
  }
}

function toGeneratedArtifact(row: PgRow): GeneratedArtifact {
  return {
    id: text(row, "id"),
    userId: text(row, "user_id"),
    type: text(row, "type") as GeneratedArtifact["type"],
    content: text(row, "content"),
    sourceExperienceIds: jsonValue<string[]>(row, "source_experience_ids", []),
    sourceEvidenceIds: jsonValue<string[]>(row, "source_evidence_ids", []),
    matchedSkillIds: jsonValue<string[]>(row, "matched_skill_ids", []),
    targetJDId: text(row, "target_jd_id"),
    targetRequirementIds: jsonValue<string[]>(row, "target_requirement_ids", []),
    targetRole: text(row, "target_role"),
    scores: jsonValue<GeneratedArtifact["scores"]>(row, "scores", {
      overall: 0,
      requirementMatch: 0,
      evidenceStrength: 0,
    }),
    status: text(row, "status") as GeneratedArtifact["status"],
    createdAt: timestamp(row, "created_at"),
    updatedAt: optionalText(row, "updated_at") ?? timestamp(row, "created_at"),
  };
}
