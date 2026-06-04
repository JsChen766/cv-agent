import type { PostgresDatabase, PostgresQueryable } from "../../persistence/postgres/PostgresDatabase.js";
import { jsonValue, optionalText, text, timestamp, type PgRow } from "../../persistence/postgres/rowUtils.js";
import type {
  ProductExperience,
  ProductExperienceRevision,
  ProductExperienceVariant,
  ProductGeneration,
  ProductImportCandidate,
  ProductImportJob,
  ProductJDRecord,
  ProductResume,
  ProductResumeItem,
} from "../types.js";
import type {
  ListOptions,
  ProductExperienceRepository,
  ProductGenerationRepository,
  ProductImportRepository,
  ProductJDRepository,
  ProductResumeRepository,
} from "./index.js";

type Db = Pick<PostgresDatabase, "query"> & Partial<Pick<PostgresDatabase, "transaction">>;

export class PostgresProductExperienceRepository implements ProductExperienceRepository {
  public constructor(private readonly database: Db) {}

  public async createExperience(record: ProductExperience): Promise<ProductExperience> {
    await this.database.query(
      `INSERT INTO product_experience (
        id, user_id, category, title, organization, role, start_date, end_date, source_document_id, tags_json,
        status, current_revision_id, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14)
      ON CONFLICT (id) DO UPDATE SET
        category = EXCLUDED.category, title = EXCLUDED.title, organization = EXCLUDED.organization,
        role = EXCLUDED.role, start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date,
        source_document_id = EXCLUDED.source_document_id, tags_json = EXCLUDED.tags_json, status = EXCLUDED.status,
        current_revision_id = EXCLUDED.current_revision_id, updated_at = EXCLUDED.updated_at`,
      [
        record.id, record.userId, record.category, record.title, record.organization ?? null,
        record.role ?? null, record.startDate ?? null, record.endDate ?? null, record.sourceDocumentId ?? null,
        JSON.stringify(record.tags), record.status, record.currentRevisionId ?? null,
        record.createdAt, record.updatedAt,
      ],
    );
    return record;
  }

  public async createExperienceWithRevision(record: ProductExperience, revision: ProductExperienceRevision): Promise<{ experience: ProductExperience; revision: ProductExperienceRevision }> {
    if (this.database.transaction) {
      return this.database.transaction(async (client: PostgresQueryable) => {
        const repository = new PostgresProductExperienceRepository(client);
        const experience = await repository.createExperience(record);
        const createdRevision = await repository.createRevision(revision);
        return { experience, revision: createdRevision };
      });
    }
    const experience = await this.createExperience(record);
    const createdRevision = await this.createRevision(revision);
    return { experience, revision: createdRevision };
  }

  public async listExperiencesByUser(userId: string, options: ListOptions & { status?: ProductExperience["status"] } = {}): Promise<ProductExperience[]> {
    const params: unknown[] = [userId];
    const statusClause = options.status ? "AND status = $2" : "";
    if (options.status) params.push(options.status);
    params.push(options.limit ?? 50);
    const result = await this.database.query<PgRow>(
      `SELECT * FROM product_experience WHERE user_id = $1 ${statusClause} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return result.rows.map(toExperience);
  }

  public async getExperienceById(userId: string, id: string): Promise<ProductExperience | null> {
    const result = await this.database.query<PgRow>("SELECT * FROM product_experience WHERE user_id = $1 AND id = $2 LIMIT 1", [userId, id]);
    return result.rows[0] ? toExperience(result.rows[0]) : null;
  }

  public async updateExperience(userId: string, id: string, patch: Partial<ProductExperience>): Promise<ProductExperience | null> {
    const current = await this.getExperienceById(userId, id);
    if (!current) return null;
    const next = { ...current, ...patch, id: current.id, userId: current.userId };
    return this.createExperience(next);
  }

  public async archiveExperience(userId: string, id: string): Promise<ProductExperience | null> {
    return this.updateExperience(userId, id, { status: "archived", updatedAt: new Date().toISOString() });
  }

  public async createRevision(record: ProductExperienceRevision): Promise<ProductExperienceRevision> {
    await this.database.query(
      `INSERT INTO product_experience_revision (
        id, experience_id, user_id, content, structured_json, source, created_at
      ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
      ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, structured_json = EXCLUDED.structured_json`,
      [record.id, record.experienceId, record.userId, record.content, JSON.stringify(record.structured ?? null), record.source, record.createdAt],
    );
    return record;
  }

  public async listRevisionsByExperience(userId: string, experienceId: string): Promise<ProductExperienceRevision[]> {
    const result = await this.database.query<PgRow>(
      "SELECT * FROM product_experience_revision WHERE user_id = $1 AND experience_id = $2 ORDER BY created_at DESC",
      [userId, experienceId],
    );
    return result.rows.map(toRevision);
  }

  public async getRevisionById(userId: string, revisionId: string): Promise<ProductExperienceRevision | null> {
    const result = await this.database.query<PgRow>(
      "SELECT * FROM product_experience_revision WHERE user_id = $1 AND id = $2 LIMIT 1",
      [userId, revisionId],
    );
    return result.rows[0] ? toRevision(result.rows[0]) : null;
  }

  public async createVariant(record: ProductExperienceVariant): Promise<ProductExperienceVariant> {
    await this.database.query(
      `INSERT INTO product_experience_variant (
        id, experience_id, revision_id, user_id, variant_type, language, target_jd_id,
        content, evidence_ids_json, score_json, status, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12)
      ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, score_json = EXCLUDED.score_json, status = EXCLUDED.status`,
      [
        record.id, record.experienceId, record.revisionId, record.userId, record.variantType,
        record.language, record.targetJdId ?? null, record.content, JSON.stringify(record.evidenceIds),
        JSON.stringify(record.score ?? null), record.status, record.createdAt,
      ],
    );
    return record;
  }

  public async listVariantsByExperience(userId: string, experienceId: string): Promise<ProductExperienceVariant[]> {
    const result = await this.database.query<PgRow>(
      "SELECT * FROM product_experience_variant WHERE user_id = $1 AND experience_id = $2 ORDER BY created_at DESC",
      [userId, experienceId],
    );
    return result.rows.map(toVariant);
  }
}

export class PostgresProductJDRepository implements ProductJDRepository {
  public constructor(private readonly database: Db) {}
  public async createJD(record: ProductJDRecord): Promise<ProductJDRecord> {
    await this.database.query(
      `INSERT INTO product_jd (id,user_id,title,company,target_role,raw_text,requirements_json,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
       ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, company=EXCLUDED.company, target_role=EXCLUDED.target_role,
       raw_text=EXCLUDED.raw_text, requirements_json=EXCLUDED.requirements_json, updated_at=EXCLUDED.updated_at`,
      [record.id, record.userId, record.title, record.company ?? null, record.targetRole ?? null, record.rawText, JSON.stringify(record.requirements ?? null), record.createdAt, record.updatedAt],
    );
    return record;
  }
  public async listJDsByUser(userId: string, options: ListOptions = {}): Promise<ProductJDRecord[]> {
    const result = await this.database.query<PgRow>("SELECT * FROM product_jd WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2", [userId, options.limit ?? 50]);
    return result.rows.map(toJD);
  }
  public async getJDById(userId: string, id: string): Promise<ProductJDRecord | null> {
    const result = await this.database.query<PgRow>("SELECT * FROM product_jd WHERE user_id = $1 AND id = $2 LIMIT 1", [userId, id]);
    return result.rows[0] ? toJD(result.rows[0]) : null;
  }
}

export class PostgresProductResumeRepository implements ProductResumeRepository {
  public constructor(private readonly database: Db) {}
  public async createResume(record: ProductResume): Promise<ProductResume> {
    await this.database.query(
      `INSERT INTO product_resume (id,user_id,title,target_role,jd_id,template_id,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title,target_role=EXCLUDED.target_role,jd_id=EXCLUDED.jd_id,
       template_id=EXCLUDED.template_id,status=EXCLUDED.status,updated_at=EXCLUDED.updated_at`,
      [record.id, record.userId, record.title, record.targetRole ?? null, record.jdId ?? null, record.templateId ?? null, record.status, record.createdAt, record.updatedAt],
    );
    return record;
  }
  public async listResumesByUser(userId: string, options: ListOptions = {}): Promise<ProductResume[]> {
    const result = await this.database.query<PgRow>("SELECT * FROM product_resume WHERE user_id = $1 AND status <> 'archived' ORDER BY created_at DESC LIMIT $2", [userId, options.limit ?? 50]);
    return result.rows.map(toResume);
  }
  public async getResumeById(userId: string, id: string): Promise<ProductResume | null> {
    const result = await this.database.query<PgRow>("SELECT * FROM product_resume WHERE user_id = $1 AND id = $2 LIMIT 1", [userId, id]);
    return result.rows[0] ? toResume(result.rows[0]) : null;
  }
  public async createResumeItem(record: ProductResumeItem): Promise<ProductResumeItem> {
    await this.database.query(
      `INSERT INTO product_resume_item (
        id,resume_id,user_id,source_experience_id,source_variant_id,source_artifact_id,section_type,title,
        content_snapshot,order_index,hidden,pinned,metadata_json,created_at,updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15)
      ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, content_snapshot=EXCLUDED.content_snapshot,
      order_index=EXCLUDED.order_index, hidden=EXCLUDED.hidden, pinned=EXCLUDED.pinned, metadata_json=EXCLUDED.metadata_json, updated_at=EXCLUDED.updated_at`,
      [
        record.id, record.resumeId, record.userId, record.sourceExperienceId ?? null, record.sourceVariantId ?? null,
        record.sourceArtifactId ?? null, record.sectionType, record.title, record.contentSnapshot, record.orderIndex,
        record.hidden, record.pinned, JSON.stringify(record.metadata), record.createdAt, record.updatedAt,
      ],
    );
    return record;
  }
  public async listResumeItems(userId: string, resumeId: string): Promise<ProductResumeItem[]> {
    const result = await this.database.query<PgRow>("SELECT * FROM product_resume_item WHERE user_id = $1 AND resume_id = $2 ORDER BY order_index ASC", [userId, resumeId]);
    return result.rows.map(toResumeItem);
  }
  public async getResumeItemById(userId: string, itemId: string): Promise<ProductResumeItem | null> {
    const result = await this.database.query<PgRow>("SELECT * FROM product_resume_item WHERE user_id = $1 AND id = $2 LIMIT 1", [userId, itemId]);
    return result.rows[0] ? toResumeItem(result.rows[0]) : null;
  }
  public async updateResumeItem(userId: string, itemId: string, patch: Partial<ProductResumeItem>): Promise<ProductResumeItem | null> {
    const current = await this.getResumeItemById(userId, itemId);
    if (!current) return null;
    return this.createResumeItem({ ...current, ...patch, id: current.id, userId: current.userId, resumeId: current.resumeId });
  }
  public async reorderResumeItems(userId: string, resumeId: string, orderedIds: string[]): Promise<ProductResumeItem[]> {
    for (const [index, id] of orderedIds.entries()) {
      await this.database.query("UPDATE product_resume_item SET order_index = $1, updated_at = $2 WHERE user_id = $3 AND resume_id = $4 AND id = $5", [index, new Date().toISOString(), userId, resumeId, id]);
    }
    return this.listResumeItems(userId, resumeId);
  }
  public async archiveResume(userId: string, resumeId: string): Promise<ProductResume | null> {
    const current = await this.getResumeById(userId, resumeId);
    if (!current) return null;
    return this.createResume({ ...current, status: "archived", updatedAt: new Date().toISOString() });
  }
}

export class PostgresProductImportRepository implements ProductImportRepository {
  public constructor(private readonly database: Db) {}
  public async createImportJob(record: ProductImportJob): Promise<ProductImportJob> {
    await this.database.query(
      `INSERT INTO product_import_job (id,user_id,source_type,status,raw_text,error_message,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, raw_text=EXCLUDED.raw_text, error_message=EXCLUDED.error_message, updated_at=EXCLUDED.updated_at`,
      [record.id, record.userId, record.sourceType, record.status, record.rawText ?? null, record.errorMessage ?? null, record.createdAt, record.updatedAt],
    );
    return record;
  }
  public async getImportJob(userId: string, id: string): Promise<ProductImportJob | null> {
    const result = await this.database.query<PgRow>("SELECT * FROM product_import_job WHERE user_id = $1 AND id = $2 LIMIT 1", [userId, id]);
    return result.rows[0] ? toImportJob(result.rows[0]) : null;
  }
  public async updateImportJobStatus(userId: string, id: string, patch: Pick<ProductImportJob, "status"> & Partial<Pick<ProductImportJob, "errorMessage" | "updatedAt">>): Promise<ProductImportJob | null> {
    const current = await this.getImportJob(userId, id);
    if (!current) return null;
    return this.createImportJob({ ...current, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() });
  }
  public async createImportCandidate(record: ProductImportCandidate): Promise<ProductImportCandidate> {
    await this.database.query(
      `INSERT INTO product_import_candidate (id,job_id,user_id,title,category,organization,role,start_date,end_date,source_document_id,content,structured_json,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15)
       ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, updated_at=EXCLUDED.updated_at`,
      [
        record.id,
        record.jobId,
        record.userId,
        record.title,
        record.category,
        record.organization ?? null,
        record.role ?? null,
        record.startDate ?? null,
        record.endDate ?? null,
        record.sourceDocumentId ?? null,
        record.content,
        JSON.stringify(record.structured ?? null),
        record.status,
        record.createdAt,
        record.updatedAt,
      ],
    );
    return record;
  }
  public async getImportCandidate(userId: string, id: string): Promise<ProductImportCandidate | null> {
    const result = await this.database.query<PgRow>("SELECT * FROM product_import_candidate WHERE user_id = $1 AND id = $2 LIMIT 1", [userId, id]);
    return result.rows[0] ? toImportCandidate(result.rows[0]) : null;
  }
  public async listCandidatesByJob(userId: string, jobId: string): Promise<ProductImportCandidate[]> {
    const result = await this.database.query<PgRow>("SELECT * FROM product_import_candidate WHERE user_id = $1 AND job_id = $2 ORDER BY created_at DESC", [userId, jobId]);
    return result.rows.map(toImportCandidate);
  }
  public async updateCandidateStatus(userId: string, id: string, status: ProductImportCandidate["status"]): Promise<ProductImportCandidate | null> {
    const current = await this.getImportCandidate(userId, id);
    if (!current) return null;
    return this.createImportCandidate({ ...current, status, updatedAt: new Date().toISOString() });
  }

  public async acceptCandidateWithExperience(input: {
    userId: string;
    candidateId: string;
    experience: ProductExperience;
    revision: ProductExperienceRevision;
  }): Promise<
    | { outcome: "accepted"; candidate: ProductImportCandidate; experience: ProductExperience; revision: ProductExperienceRevision }
    | { outcome: "not_pending"; candidate: ProductImportCandidate }
    | null
  > {
    if (!this.database.transaction) return null;
    return this.database.transaction(async (client: PostgresQueryable) => {
      const selected = await client.query<PgRow>(
        "SELECT * FROM product_import_candidate WHERE user_id = $1 AND id = $2 LIMIT 1 FOR UPDATE",
        [input.userId, input.candidateId],
      );
      const candidate = selected.rows[0] ? toImportCandidate(selected.rows[0]) : null;
      if (!candidate) return null;
      if (candidate.status !== "pending") return { outcome: "not_pending", candidate };

      const experienceRepository = new PostgresProductExperienceRepository(client);
      const saved = await experienceRepository.createExperienceWithRevision(input.experience, input.revision);
      const updated = await client.query<PgRow>(
        `UPDATE product_import_candidate
         SET status = 'accepted', updated_at = $3
         WHERE user_id = $1 AND id = $2 AND status = 'pending'
         RETURNING *`,
        [input.userId, input.candidateId, new Date().toISOString()],
      );
      const updatedCandidate = updated.rows[0] ? toImportCandidate(updated.rows[0]) : candidate;
      return {
        outcome: "accepted" as const,
        candidate: updatedCandidate,
        experience: saved.experience,
        revision: saved.revision,
      };
    });
  }
}

export class PostgresProductGenerationRepository implements ProductGenerationRepository {
  public constructor(private readonly database: Db) {}
  public async createGeneration(record: ProductGeneration): Promise<ProductGeneration> {
    await this.database.query(
      `INSERT INTO product_generation (id,user_id,session_id,jd_id,resume_id,target_role,input_snapshot_json,output_snapshot_json,selected_variant_ids_json,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10)
       ON CONFLICT (id) DO UPDATE SET resume_id=EXCLUDED.resume_id, output_snapshot_json=EXCLUDED.output_snapshot_json, selected_variant_ids_json=EXCLUDED.selected_variant_ids_json`,
      [
        record.id, record.userId, record.sessionId ?? null, record.jdId ?? null, record.resumeId ?? null,
        record.targetRole ?? null, JSON.stringify(record.inputSnapshot), JSON.stringify(record.outputSnapshot ?? null),
        JSON.stringify(record.selectedVariantIds), record.createdAt,
      ],
    );
    return record;
  }
  public async getGeneration(userId: string, id: string): Promise<ProductGeneration | null> {
    const result = await this.database.query<PgRow>("SELECT * FROM product_generation WHERE user_id = $1 AND id = $2 LIMIT 1", [userId, id]);
    return result.rows[0] ? toGeneration(result.rows[0]) : null;
  }
  public async listGenerationsByUser(userId: string, options: ListOptions = {}): Promise<ProductGeneration[]> {
    const result = await this.database.query<PgRow>("SELECT * FROM product_generation WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2", [userId, options.limit ?? 50]);
    return result.rows.map(toGeneration);
  }
  public async updateGenerationSelection(userId: string, id: string, selectedVariantIds: string[]): Promise<ProductGeneration | null> {
    const current = await this.getGeneration(userId, id);
    if (!current) return null;
    return this.createGeneration({ ...current, selectedVariantIds });
  }
  public async attachResume(userId: string, id: string, resumeId: string): Promise<ProductGeneration | null> {
    const current = await this.getGeneration(userId, id);
    if (!current) return null;
    return this.createGeneration({ ...current, resumeId });
  }

  public async saveAcceptedVariantToResume(input: {
    userId: string;
    generationId: string;
    resume: ProductResume;
    item: ProductResumeItem;
    selectedVariantIds: string[];
  }): Promise<{ generation: ProductGeneration; resume: ProductResume; item: ProductResumeItem } | null> {
    if (!this.database.transaction) return null;
    return this.database.transaction(async (client: PostgresQueryable) => {
      const generationRepository = new PostgresProductGenerationRepository(client);
      const generation = await generationRepository.getGeneration(input.userId, input.generationId);
      if (!generation) return null;
      const resumeRepository = new PostgresProductResumeRepository(client);
      const resume = await resumeRepository.createResume(input.resume);
      const item = await resumeRepository.createResumeItem(input.item);
      const attached = await generationRepository.createGeneration({
        ...generation,
        resumeId: resume.id,
        selectedVariantIds: input.selectedVariantIds,
      });
      return { generation: attached, resume, item };
    });
  }
}

function toExperience(row: PgRow): ProductExperience {
  return { id: text(row, "id"), userId: text(row, "user_id"), category: text(row, "category") as ProductExperience["category"], title: text(row, "title"), organization: optionalText(row, "organization"), role: optionalText(row, "role"), startDate: optionalText(row, "start_date"), endDate: optionalText(row, "end_date"), sourceDocumentId: optionalText(row, "source_document_id"), tags: jsonValue<string[]>(row, "tags_json", []), status: text(row, "status") as ProductExperience["status"], currentRevisionId: optionalText(row, "current_revision_id"), createdAt: timestamp(row, "created_at"), updatedAt: timestamp(row, "updated_at") };
}
function toRevision(row: PgRow): ProductExperienceRevision {
  return { id: text(row, "id"), experienceId: text(row, "experience_id"), userId: text(row, "user_id"), content: text(row, "content"), structured: jsonValue<Record<string, unknown> | undefined>(row, "structured_json", undefined), source: text(row, "source") as ProductExperienceRevision["source"], createdAt: timestamp(row, "created_at") };
}
function toVariant(row: PgRow): ProductExperienceVariant {
  return { id: text(row, "id"), experienceId: text(row, "experience_id"), revisionId: text(row, "revision_id"), userId: text(row, "user_id"), variantType: text(row, "variant_type") as ProductExperienceVariant["variantType"], language: text(row, "language") as ProductExperienceVariant["language"], targetJdId: optionalText(row, "target_jd_id"), content: text(row, "content"), evidenceIds: jsonValue<string[]>(row, "evidence_ids_json", []), score: jsonValue(row, "score_json", undefined), status: text(row, "status") as ProductExperienceVariant["status"], createdAt: timestamp(row, "created_at") };
}
function toJD(row: PgRow): ProductJDRecord {
  return { id: text(row, "id"), userId: text(row, "user_id"), title: text(row, "title"), company: optionalText(row, "company"), targetRole: optionalText(row, "target_role"), rawText: text(row, "raw_text"), requirements: jsonValue(row, "requirements_json", undefined), createdAt: timestamp(row, "created_at"), updatedAt: timestamp(row, "updated_at") };
}
function toResume(row: PgRow): ProductResume {
  return { id: text(row, "id"), userId: text(row, "user_id"), title: text(row, "title"), targetRole: optionalText(row, "target_role"), jdId: optionalText(row, "jd_id"), templateId: optionalText(row, "template_id"), status: text(row, "status") as ProductResume["status"], createdAt: timestamp(row, "created_at"), updatedAt: timestamp(row, "updated_at") };
}
function toResumeItem(row: PgRow): ProductResumeItem {
  return { id: text(row, "id"), resumeId: text(row, "resume_id"), userId: text(row, "user_id"), sourceExperienceId: optionalText(row, "source_experience_id"), sourceVariantId: optionalText(row, "source_variant_id"), sourceArtifactId: optionalText(row, "source_artifact_id"), sectionType: text(row, "section_type") as ProductResumeItem["sectionType"], title: text(row, "title"), contentSnapshot: text(row, "content_snapshot"), orderIndex: Number(row.order_index), hidden: Boolean(row.hidden), pinned: Boolean(row.pinned), metadata: jsonValue<Record<string, unknown>>(row, "metadata_json", {}), createdAt: timestamp(row, "created_at"), updatedAt: timestamp(row, "updated_at") };
}
function toImportJob(row: PgRow): ProductImportJob {
  return { id: text(row, "id"), userId: text(row, "user_id"), sourceType: text(row, "source_type") as ProductImportJob["sourceType"], status: text(row, "status") as ProductImportJob["status"], rawText: optionalText(row, "raw_text"), errorMessage: optionalText(row, "error_message"), createdAt: timestamp(row, "created_at"), updatedAt: timestamp(row, "updated_at") };
}
function toImportCandidate(row: PgRow): ProductImportCandidate {
  return { id: text(row, "id"), jobId: text(row, "job_id"), userId: text(row, "user_id"), title: text(row, "title"), category: text(row, "category") as ProductImportCandidate["category"], organization: optionalText(row, "organization"), role: optionalText(row, "role"), startDate: optionalText(row, "start_date"), endDate: optionalText(row, "end_date"), sourceDocumentId: optionalText(row, "source_document_id"), content: text(row, "content"), structured: jsonValue<Record<string, unknown> | undefined>(row, "structured_json", undefined), status: text(row, "status") as ProductImportCandidate["status"], createdAt: timestamp(row, "created_at"), updatedAt: timestamp(row, "updated_at") };
}
function toGeneration(row: PgRow): ProductGeneration {
  return { id: text(row, "id"), userId: text(row, "user_id"), sessionId: optionalText(row, "session_id"), jdId: optionalText(row, "jd_id"), resumeId: optionalText(row, "resume_id"), targetRole: optionalText(row, "target_role"), inputSnapshot: jsonValue<Record<string, unknown>>(row, "input_snapshot_json", {}), outputSnapshot: jsonValue<ProductGeneration["outputSnapshot"]>(row, "output_snapshot_json", undefined), selectedVariantIds: jsonValue<string[]>(row, "selected_variant_ids_json", []), createdAt: timestamp(row, "created_at") };
}
