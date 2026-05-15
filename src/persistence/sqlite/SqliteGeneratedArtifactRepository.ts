import type { GeneratedArtifactRepository } from "../../knowledge/repositories.js";
import type { GeneratedArtifact } from "../../knowledge/types.js";
import type { SqliteDatabase } from "./SqliteDatabase.js";
import { jsonValue, text } from "./rowUtils.js";

export class SqliteGeneratedArtifactRepository implements GeneratedArtifactRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public async getById(id: string): Promise<GeneratedArtifact | null> {
    const row = this.database.get("SELECT * FROM generated_artifacts WHERE id = ?", [id]);
    return row ? this.toArtifact(row) : null;
  }

  public async getByExperienceId(experienceId: string): Promise<GeneratedArtifact[]> {
    return this.database.all("SELECT * FROM generated_artifacts ORDER BY created_at")
      .map((row) => this.toArtifact(row))
      .filter((artifact) => artifact.sourceExperienceIds.includes(experienceId));
  }

  public async listByUserId(userId: string): Promise<GeneratedArtifact[]> {
    return this.database.all("SELECT * FROM generated_artifacts WHERE user_id = ? ORDER BY created_at", [userId])
      .map((row) => this.toArtifact(row));
  }

  public async save(artifact: GeneratedArtifact): Promise<void> {
    this.database.run(
      `INSERT OR REPLACE INTO generated_artifacts (
        id, user_id, type, content, source_experience_ids_json, source_evidence_ids_json,
        matched_skill_ids_json, target_jd_id, target_requirement_ids_json, target_role,
        scores_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        artifact.createdAt,
        artifact.updatedAt,
      ],
    );
    this.database.save();
  }

  public async delete(id: string): Promise<void> {
    this.database.run("DELETE FROM generated_artifacts WHERE id = ?", [id]);
    this.database.save();
  }

  private toArtifact(row: Record<string, import("sql.js").SqlValue>): GeneratedArtifact {
    return {
      id: text(row, "id"),
      userId: text(row, "user_id"),
      type: text(row, "type") as GeneratedArtifact["type"],
      content: text(row, "content"),
      sourceExperienceIds: jsonValue(row, "source_experience_ids_json"),
      sourceEvidenceIds: jsonValue(row, "source_evidence_ids_json"),
      matchedSkillIds: jsonValue(row, "matched_skill_ids_json"),
      targetJDId: text(row, "target_jd_id"),
      targetRequirementIds: jsonValue(row, "target_requirement_ids_json"),
      targetRole: text(row, "target_role"),
      scores: jsonValue(row, "scores_json"),
      status: text(row, "status") as GeneratedArtifact["status"],
      createdAt: text(row, "created_at"),
      updatedAt: text(row, "updated_at"),
    };
  }
}
