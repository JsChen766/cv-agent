import type { PostgresDatabase } from "../../persistence/postgres/PostgresDatabase.js";
import { jsonValue, optionalText, text, timestamp, type PgRow } from "../../persistence/postgres/rowUtils.js";
import type { GuidelineRepository } from "./GuidelineRepository.js";
import { DEFAULT_GUIDELINES } from "./defaultGuidelines.js";
import type { GuidelineChunk, GuidelineLanguage } from "./types.js";

type Db = Pick<PostgresDatabase, "query">;

export class PostgresGuidelineRepository implements GuidelineRepository {
  public constructor(private readonly database: Db) {}

  public async upsertGuidelineChunks(chunks: GuidelineChunk[]): Promise<GuidelineChunk[]> {
    for (const chunk of chunks) {
      await this.database.query(
        `INSERT INTO product_guideline_chunk (
          id,source_type,role_family,industry,application_type,language,title,content,tags_json,metadata_json,created_at,updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12)
        ON CONFLICT (id) DO UPDATE SET
          source_type=EXCLUDED.source_type,
          role_family=EXCLUDED.role_family,
          industry=EXCLUDED.industry,
          application_type=EXCLUDED.application_type,
          language=EXCLUDED.language,
          title=EXCLUDED.title,
          content=EXCLUDED.content,
          tags_json=EXCLUDED.tags_json,
          metadata_json=EXCLUDED.metadata_json,
          updated_at=EXCLUDED.updated_at`,
        [
          chunk.id,
          chunk.sourceType,
          chunk.roleFamily ?? null,
          chunk.industry ?? null,
          chunk.applicationType ?? null,
          chunk.language,
          chunk.title,
          chunk.content,
          JSON.stringify(chunk.tags),
          JSON.stringify(chunk.metadata),
          chunk.createdAt,
          chunk.updatedAt,
        ],
      );
    }
    return chunks;
  }

  public async listGuidelineChunks(input: {
    language?: GuidelineLanguage;
    roleFamily?: string;
    applicationType?: string;
    limit?: number;
  } = {}): Promise<GuidelineChunk[]> {
    await this.ensureDefaultGuidelines();
    const result = await this.database.query<PgRow>(
      `SELECT * FROM product_guideline_chunk
       WHERE ($1::text IS NULL OR language = $1 OR language = 'en')
         AND ($2::text IS NULL OR role_family IS NULL OR role_family = $2)
         AND ($3::text IS NULL OR application_type IS NULL OR application_type = $3)
       ORDER BY updated_at DESC
       LIMIT $4`,
      [input.language ?? null, input.roleFamily ?? null, input.applicationType ?? null, input.limit ?? 200],
    );
    return result.rows.map(toGuidelineChunk);
  }

  private async ensureDefaultGuidelines(): Promise<void> {
    const result = await this.database.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM product_guideline_chunk");
    if (Number(result.rows[0]?.count ?? "0") > 0) return;
    await this.upsertGuidelineChunks(DEFAULT_GUIDELINES);
  }
}

function toGuidelineChunk(row: PgRow): GuidelineChunk {
  return {
    id: text(row, "id"),
    sourceType: text(row, "source_type") as GuidelineChunk["sourceType"],
    roleFamily: optionalText(row, "role_family"),
    industry: optionalText(row, "industry"),
    applicationType: optionalText(row, "application_type") as GuidelineChunk["applicationType"],
    language: text(row, "language") as GuidelineChunk["language"],
    title: text(row, "title"),
    content: text(row, "content"),
    tags: jsonValue<string[]>(row, "tags_json", []),
    metadata: jsonValue<Record<string, unknown>>(row, "metadata_json", {}),
    createdAt: timestamp(row, "created_at"),
    updatedAt: timestamp(row, "updated_at"),
  };
}
