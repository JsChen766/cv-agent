import type { JDRequirementRepository } from "../../knowledge/repositories.js";
import type { JDRequirement } from "../../knowledge/types.js";
import type { SqliteDatabase } from "./SqliteDatabase.js";
import { jsonValue, numberValue, text } from "./rowUtils.js";

export class SqliteJDRequirementRepository implements JDRequirementRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public async getById(id: string): Promise<JDRequirement | null> {
    const row = this.database.get("SELECT * FROM jd_requirements WHERE id = ?", [id]);
    return row ? this.toRequirement(row) : null;
  }

  public async listByUserId(userId: string): Promise<JDRequirement[]> {
    return this.database.all("SELECT * FROM jd_requirements WHERE user_id = ? ORDER BY created_at", [userId])
      .map((row) => this.toRequirement(row));
  }

  public async listByJDId(userId: string, jdId: string): Promise<JDRequirement[]> {
    return this.database.all(
      "SELECT * FROM jd_requirements WHERE user_id = ? AND jd_id = ? ORDER BY created_at",
      [userId, jdId],
    ).map((row) => this.toRequirement(row));
  }

  public async save(requirement: JDRequirement): Promise<void> {
    this.database.run(
      `INSERT OR REPLACE INTO jd_requirements (
        id, user_id, jd_id, description, required_skill_ids_json, weight, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
    this.database.save();
  }

  public async delete(id: string): Promise<void> {
    this.database.run("DELETE FROM jd_requirements WHERE id = ?", [id]);
    this.database.save();
  }

  private toRequirement(row: Record<string, import("sql.js").SqlValue>): JDRequirement {
    return {
      id: text(row, "id"),
      userId: text(row, "user_id"),
      jdId: text(row, "jd_id"),
      description: text(row, "description"),
      requiredSkillIds: jsonValue(row, "required_skill_ids_json"),
      weight: numberValue(row, "weight"),
      createdAt: text(row, "created_at"),
    };
  }
}
