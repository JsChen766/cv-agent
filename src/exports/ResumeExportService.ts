import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FileService } from "../files/index.js";
import type { PlatformServices } from "../platform/index.js";
import { readPlatformConfig } from "../platform/config.js";
import type { ResumeService } from "../product/index.js";
import { ApiError, ErrorCodes } from "../api/errors.js";
import type { ResumeExportRepository } from "./ResumeExportRepository.js";
import { ResumeHtmlRenderer } from "./ResumeHtmlRenderer.js";
import type { ResumeExport, ResumeExportFormat } from "./types.js";

export class ResumeExportService {
  private readonly renderer = new ResumeHtmlRenderer();

  public constructor(
    private readonly repository: ResumeExportRepository,
    private readonly resumeService: ResumeService,
    private readonly fileService: FileService,
    private readonly platformServices: PlatformServices,
  ) {}

  public async createExport(userId: string, input: { resumeId: string; format: ResumeExportFormat; templateId?: string }): Promise<{ exportRecord: ResumeExport; job: Awaited<ReturnType<PlatformServices["backgroundJobs"]["createJob"]>> }> {
    if (input.format === "docx") throw new ApiError(ErrorCodes.INVALID_BODY, "DOCX export is not supported yet.", 400);
    if (input.format === "pdf" && readPlatformConfig().pdfRenderer === "none") {
      throw new ApiError(ErrorCodes.INTERNAL_ERROR, "PDF renderer is not configured. Set PDF_RENDERER=playwright or PDF_RENDERER=external.", 503);
    }
    const now = new Date().toISOString();
    const record = await this.repository.createExport({
      id: `export-${randomUUID()}`,
      userId,
      resumeId: input.resumeId,
      format: input.format,
      templateId: input.templateId ?? "default",
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    const job = await this.platformServices.backgroundJobs.enqueue({
      userId,
      type: input.format === "pdf" ? "export_resume_pdf" : "export_resume_html",
      input: { exportId: record.id, resumeId: input.resumeId, format: input.format },
      progress: 0,
      priority: 0,
      maxAttempts: 3,
    });
    const updated = await this.repository.updateExport(userId, record.id, { jobId: job.id });
    return { exportRecord: updated ?? record, job };
  }

  public getExport(userId: string, id: string): Promise<ResumeExport | null> {
    return this.repository.getExport(userId, id);
  }

  public listExports(userId: string, limit?: number): Promise<ResumeExport[]> {
    return this.repository.listExports(userId, limit);
  }

  public async deleteExport(userId: string, id: string): Promise<ResumeExport | null> {
    return this.repository.updateExport(userId, id, { status: "deleted" });
  }

  public async renderExportJob(userId: string, exportId: string): Promise<ResumeExport> {
    const record = await this.repository.getExport(userId, exportId);
    if (!record) throw new ApiError(ErrorCodes.NOT_FOUND, "Export not found.", 404);
    if (record.format === "pdf" && readPlatformConfig().pdfRenderer === "none") {
      throw new ApiError(ErrorCodes.INTERNAL_ERROR, "PDF renderer is not configured.", 503);
    }
    const resume = await this.resumeService.getResume(userId, record.resumeId);
    if (!resume) throw new ApiError(ErrorCodes.NOT_FOUND, "Resume not found.", 404);
    await this.repository.updateExport(userId, exportId, { status: "rendering" });
    const html = this.renderer.render(resume, record.templateId);
    const file = await this.fileService.uploadFile(userId, {
      originalName: `${resume.title || "resume"}.html`,
      mimeType: "text/plain",
      buffer: Buffer.from(html, "utf8"),
    });
    const token = `dl_${randomBytes(24).toString("base64url")}`;
    const completed = await this.repository.updateExport(userId, exportId, {
      status: "completed",
      fileId: file.id,
      downloadTokenHash: createHash("sha256").update(token).digest("hex"),
      downloadExpiresAt: new Date(Date.now() + readDownloadTtlMinutes() * 60_000).toISOString(),
      completedAt: new Date().toISOString(),
    });
    return completed ?? record;
  }

  public async readDownload(userId: string, id: string): Promise<{ exportRecord: ResumeExport; fileText: string }> {
    const record = await this.repository.getExport(userId, id);
    if (!record || record.status !== "completed" || !record.fileId) {
      throw new ApiError(ErrorCodes.NOT_FOUND, "Export is not ready.", 404);
    }
    const parsed = await this.fileService.getParsedDocumentByFileId(userId, record.fileId);
    if (parsed) return { exportRecord: record, fileText: parsed.text };
    const file = await this.fileService.getFile(userId, record.fileId);
    if (!file) throw new ApiError(ErrorCodes.NOT_FOUND, "Export file not found.", 404);
    const document = await this.fileService.parseFile(userId, file.id);
    return { exportRecord: record, fileText: document.text };
  }
}

function readDownloadTtlMinutes(): number {
  return readPlatformConfig().exportDownloadTtlMinutes;
}
