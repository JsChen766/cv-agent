import type { PostgresQueryable } from "../persistence/postgres/PostgresDatabase.js";
import type { ResumeExportRepository } from "./ResumeExportRepository.js";
import type { ResumeFitReport } from "./ResumeFitService.js";
import type { ResumeCompressionReport } from "./ResumeCompressionService.js";
import type { ResumeFitEditorReport } from "./ResumeLLMFitEditor.js";
import type { ResumeQualityReport } from "./ResumeQualityService.js";
import type { ResumeExport } from "./types.js";

export class PostgresResumeExportRepository implements ResumeExportRepository {
  public constructor(private readonly database: PostgresQueryable) {}

  public async createExport(record: ResumeExport): Promise<ResumeExport> {
    await this.database.query(
      `INSERT INTO resume_export (id,user_id,resume_id,job_id,format,template_id,status,file_id,download_token_hash,download_expires_at,error_message,created_at,updated_at,completed_at,fit_report,compression_report,edit_report,quality_report)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [record.id, record.userId, record.resumeId, record.jobId ?? null, record.format, record.templateId ?? null, record.status, record.fileId ?? null, record.downloadTokenHash ?? null, record.downloadExpiresAt ?? null, record.errorMessage ?? null, record.createdAt, record.updatedAt, record.completedAt ?? null, record.fitReport ? JSON.stringify(record.fitReport) : null, record.compressionReport ? JSON.stringify(record.compressionReport) : null, record.editReport ? JSON.stringify(record.editReport) : null, record.qualityReport ? JSON.stringify(record.qualityReport) : null],
    );
    return record;
  }

  public async getExport(userId: string, id: string): Promise<ResumeExport | null> {
    const result = await this.database.query<any>(`SELECT * FROM resume_export WHERE user_id=$1 AND id=$2 AND status <> 'deleted'`, [userId, id]);
    return result.rows[0] ? toExport(result.rows[0]) : null;
  }

  public async listExports(userId: string, limit = 50): Promise<ResumeExport[]> {
    const result = await this.database.query<any>(`SELECT * FROM resume_export WHERE user_id=$1 AND status <> 'deleted' ORDER BY created_at DESC LIMIT $2`, [userId, limit]);
    return result.rows.map(toExport);
  }

  public async updateExport(userId: string, id: string, patch: Partial<ResumeExport>): Promise<ResumeExport | null> {
    await this.database.query(
      `UPDATE resume_export SET job_id=COALESCE($3,job_id), status=COALESCE($4,status), file_id=COALESCE($5,file_id), download_token_hash=COALESCE($6,download_token_hash), download_expires_at=COALESCE($7,download_expires_at), error_message=$8, completed_at=COALESCE($9,completed_at), fit_report=COALESCE($10::jsonb,fit_report), compression_report=COALESCE($11::jsonb,compression_report), edit_report=COALESCE($12::jsonb,edit_report), quality_report=COALESCE($13::jsonb,quality_report), updated_at=$14 WHERE user_id=$1 AND id=$2`,
      [userId, id, patch.jobId ?? null, patch.status ?? null, patch.fileId ?? null, patch.downloadTokenHash ?? null, patch.downloadExpiresAt ?? null, patch.errorMessage ?? null, patch.completedAt ?? null, patch.fitReport ? JSON.stringify(patch.fitReport) : null, patch.compressionReport ? JSON.stringify(patch.compressionReport) : null, patch.editReport ? JSON.stringify(patch.editReport) : null, patch.qualityReport ? JSON.stringify(patch.qualityReport) : null, new Date().toISOString()],
    );
    return this.getExport(userId, id);
  }
}

function toExport(row: any): ResumeExport {
  const base: ResumeExport = {
    id: row.id,
    userId: row.user_id,
    resumeId: row.resume_id,
    jobId: row.job_id ?? undefined,
    format: row.format,
    templateId: row.template_id ?? undefined,
    status: row.status,
    fileId: row.file_id ?? undefined,
    downloadTokenHash: row.download_token_hash ?? undefined,
    downloadExpiresAt: row.download_expires_at ? new Date(row.download_expires_at).toISOString() : undefined,
    errorMessage: row.error_message ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : undefined,
  };
  const fitReport = parseJsonb<ResumeFitReport>(row.fit_report);
  if (fitReport) base.fitReport = fitReport;
  const compressionReport = parseJsonb<ResumeCompressionReport>(row.compression_report);
  if (compressionReport) base.compressionReport = compressionReport;
  const editReport = parseJsonb<ResumeFitEditorReport>(row.edit_report);
  if (editReport) base.editReport = editReport;
  const qualityReport = parseJsonb<ResumeQualityReport>(row.quality_report);
  if (qualityReport) base.qualityReport = qualityReport;
  return base;
}

function parseJsonb<T>(raw: unknown): T | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }
  if (typeof raw === "object") return raw as T;
  return undefined;
}
