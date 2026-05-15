import type { ExperienceRepository } from "../../knowledge/repositories.js";
import type { Experience } from "../../knowledge/types.js";
import type { SqliteDatabase } from "./SqliteDatabase.js";
import { jsonValue, numberValue, text } from "./rowUtils.js";

export class SqliteExperienceRepository implements ExperienceRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public async getById(id: string): Promise<Experience | null> {
    const row = this.database.get("SELECT * FROM experiences WHERE id = ?", [id]);
    return row ? this.toExperience(row) : null;
  }

  public async list(): Promise<Experience[]> {
    return this.database.all("SELECT * FROM experiences ORDER BY created_at").map((row) => this.toExperience(row));
  }

  public async listByUserId(userId: string): Promise<Experience[]> {
    return this.database.all("SELECT * FROM experiences WHERE user_id = ? ORDER BY created_at", [userId])
      .map((row) => this.toExperience(row));
  }

  public async save(experience: Experience): Promise<void> {
    this.database.run(
      `INSERT OR REPLACE INTO experiences (
        id, user_id, type, organization, role, summary, time_range_json, star_json,
        evidence_ids_json, skill_ids_json, confidence, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        experience.createdAt,
        experience.updatedAt,
      ],
    );
    this.database.save();
  }

  public async delete(id: string): Promise<void> {
    this.database.run("DELETE FROM experiences WHERE id = ?", [id]);
    this.database.save();
  }

  private toExperience(row: Record<string, import("sql.js").SqlValue>): Experience {
    return {
      id: text(row, "id"),
      userId: text(row, "user_id"),
      type: text(row, "type") as Experience["type"],
      organization: text(row, "organization"),
      role: text(row, "role"),
      summary: text(row, "summary"),
      timeRange: jsonValue(row, "time_range_json"),
      star: jsonValue(row, "star_json"),
      evidenceIds: jsonValue(row, "evidence_ids_json"),
      skillIds: jsonValue(row, "skill_ids_json"),
      confidence: numberValue(row, "confidence"),
      createdAt: text(row, "created_at"),
      updatedAt: text(row, "updated_at"),
    };
  }
}
