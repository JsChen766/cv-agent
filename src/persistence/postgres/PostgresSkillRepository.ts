import type { SkillRepository } from "../../knowledge/repositories.js";
import type { Skill } from "../../knowledge/types.js";
import type { PostgresDatabase } from "./PostgresDatabase.js";
import { jsonValue, text, timestamp } from "./rowUtils.js";

export class PostgresSkillRepository implements SkillRepository {
  public constructor(private readonly database: Pick<PostgresDatabase, "query">) {}

  public async getById(id: string): Promise<Skill | null> {
    const result = await this.database.query("SELECT * FROM skills WHERE id = $1", [id]);
    return result.rows[0] ? this.toSkill(result.rows[0]) : null;
  }

  public async getByIdForUser(userId: string, id: string): Promise<Skill | null> {
    const result = await this.database.query("SELECT * FROM skills WHERE user_id = $1 AND id = $2", [userId, id]);
    return result.rows[0] ? this.toSkill(result.rows[0]) : null;
  }

  public async findByName(userId: string, name: string): Promise<Skill | null> {
    const result = await this.database.query(
      "SELECT * FROM skills WHERE user_id = $1 AND lower(name) = lower($2) LIMIT 1",
      [userId, name.trim()],
    );
    return result.rows[0] ? this.toSkill(result.rows[0]) : null;
  }

  public async listByUserId(userId: string): Promise<Skill[]> {
    const result = await this.database.query("SELECT * FROM skills WHERE user_id = $1 ORDER BY created_at", [userId]);
    return result.rows.map((row) => this.toSkill(row));
  }

  public async save(skill: Skill): Promise<void> {
    await this.database.query(
      `INSERT INTO skills (
        id, user_id, name, category, evidence_ids, metadata, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5::jsonb, '{}'::jsonb, $6, $7)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        category = EXCLUDED.category,
        evidence_ids = EXCLUDED.evidence_ids,
        updated_at = EXCLUDED.updated_at`,
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
  }

  public async delete(id: string): Promise<void> {
    await this.database.query("DELETE FROM skills WHERE id = $1", [id]);
  }

  public async deleteForUser(userId: string, id: string): Promise<void> {
    await this.database.query("DELETE FROM skills WHERE user_id = $1 AND id = $2", [userId, id]);
  }

  private toSkill(row: Record<string, unknown>): Skill {
    return {
      id: text(row, "id"),
      userId: text(row, "user_id"),
      name: text(row, "name"),
      category: text(row, "category") as Skill["category"],
      evidenceIds: jsonValue(row, "evidence_ids"),
      createdAt: timestamp(row, "created_at"),
      updatedAt: timestamp(row, "updated_at"),
    };
  }
}
