import type { JDRequirementRepository } from "../../knowledge/repositories.js";
import type { JDRequirement } from "../../knowledge/types.js";
import type { PostgresDatabase } from "./PostgresDatabase.js";
import { jsonValue, numberValue, text, timestamp } from "./rowUtils.js";

export class PostgresJDRequirementRepository implements JDRequirementRepository {
  public constructor(private readonly database: Pick<PostgresDatabase, "query">) {}

  // Legacy interface method. Do not expose through backend/API.
  // Prefer getByIdForUser.
  public async getById(id: string): Promise<JDRequirement | null> {
    const result = await this.database.query("SELECT * FROM jd_requirements WHERE id = $1", [id]);
    return result.rows[0] ? this.toRequirement(result.rows[0]) : null;
  }

  public async getByIdForUser(userId: string, id: string): Promise<JDRequirement | null> {
    const result = await this.database.query("SELECT * FROM jd_requirements WHERE user_id = $1 AND id = $2", [userId, id]);
    return result.rows[0] ? this.toRequirement(result.rows[0]) : null;
  }

  public async listByUserId(userId: string): Promise<JDRequirement[]> {
    const result = await this.database.query("SELECT * FROM jd_requirements WHERE user_id = $1 ORDER BY created_at", [userId]);
    return result.rows.map((row) => this.toRequirement(row));
  }

  public async listByJDId(userId: string, jdId: string): Promise<JDRequirement[]> {
    const result = await this.database.query(
      "SELECT * FROM jd_requirements WHERE user_id = $1 AND jd_id = $2 ORDER BY created_at",
      [userId, jdId],
    );
    return result.rows.map((row) => this.toRequirement(row));
  }

  public async save(requirement: JDRequirement): Promise<void> {
    await this.database.query(
      `INSERT INTO jd_requirements (
        id, user_id, jd_id, description, required_skill_ids, weight, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, '{}'::jsonb, $7)
      ON CONFLICT (id) DO UPDATE SET
        description = EXCLUDED.description,
        required_skill_ids = EXCLUDED.required_skill_ids,
        weight = EXCLUDED.weight`,
      [
        requirement.id,
        requirement.userId,
        requirement.jdId,
        requirement.description,
        JSON.stringify(requirement.requiredSkillIds),
        requirement.weight,
        requirement.createdAt,
      ],
    );
  }

  // Legacy interface method. Do not expose through backend/API.
  // Prefer deleteForUser.
  public async delete(id: string): Promise<void> {
    await this.database.query("DELETE FROM jd_requirements WHERE id = $1", [id]);
  }

  public async deleteForUser(userId: string, id: string): Promise<void> {
    await this.database.query("DELETE FROM jd_requirements WHERE user_id = $1 AND id = $2", [userId, id]);
  }

  private toRequirement(row: Record<string, unknown>): JDRequirement {
    return {
      id: text(row, "id"),
      userId: text(row, "user_id"),
      jdId: text(row, "jd_id"),
      description: text(row, "description"),
      requiredSkillIds: jsonValue(row, "required_skill_ids"),
      weight: numberValue(row, "weight"),
      createdAt: timestamp(row, "created_at"),
    };
  }
}
