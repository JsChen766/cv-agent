import type { SkillRepository } from "../../knowledge/repositories.js";
import type { Skill } from "../../knowledge/types.js";
import type { SqliteDatabase } from "./SqliteDatabase.js";
import { jsonValue, text } from "./rowUtils.js";

export class SqliteSkillRepository implements SkillRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public async getById(id: string): Promise<Skill | null> {
    const row = this.database.get("SELECT * FROM skills WHERE id = ?", [id]);
    return row ? this.toSkill(row) : null;
  }

  public async findByName(userId: string, name: string): Promise<Skill | null> {
    const row = this.database.get(
      "SELECT * FROM skills WHERE user_id = ? AND lower(name) = lower(?) LIMIT 1",
      [userId, name.trim()],
    );
    return row ? this.toSkill(row) : null;
  }

  public async listByUserId(userId: string): Promise<Skill[]> {
    return this.database.all("SELECT * FROM skills WHERE user_id = ? ORDER BY created_at", [userId])
      .map((row) => this.toSkill(row));
  }

  public async save(skill: Skill): Promise<void> {
    this.database.run(
      `INSERT OR REPLACE INTO skills (
        id, user_id, name, category, evidence_ids_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        skill.id,
        skill.userId,
        skill.name,
        skill.category,
        JSON.stringify(skill.evidenceIds),
        skill.createdAt,
        skill.updatedAt,
      ],
    );
    this.database.save();
  }

  public async delete(id: string): Promise<void> {
    this.database.run("DELETE FROM skills WHERE id = ?", [id]);
    this.database.save();
  }

  private toSkill(row: Record<string, import("sql.js").SqlValue>): Skill {
    return {
      id: text(row, "id"),
      userId: text(row, "user_id"),
      name: text(row, "name"),
      category: text(row, "category") as Skill["category"],
      evidenceIds: jsonValue(row, "evidence_ids_json"),
      createdAt: text(row, "created_at"),
      updatedAt: text(row, "updated_at"),
    };
  }
}
