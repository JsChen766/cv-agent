import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FileService } from "../files/index.js";
import type { PlatformServices } from "../platform/index.js";
import { readPlatformConfig } from "../platform/config.js";
import type { ResumeService } from "../product/index.js";
import { ApiError, ErrorCodes } from "../api/errors.js";
import type { ResumeExportRepository } from "./ResumeExportRepository.js";
import { ResumeHtmlRenderer } from "./ResumeHtmlRenderer.js";
import {
  PdfRenderError,
  PlaywrightPdfRenderer,
  type PdfRendererAdapter,
} from "./PdfRendererAdapter.js";
import {
  HeuristicLayoutMeasurer,
  ResumeFitMeasureError,
  ResumeFitService,
  type ResumeFitReport,
  type ResumeLayoutMeasurer,
} from "./ResumeFitService.js";
import type { ResumeExport, ResumeExportFormat } from "./types.js";

const PDF_RENDERER_NONE = "none";
const PDF_RENDERER_PLAYWRIGHT = "playwright";

export class ResumeExportService {
  private readonly renderer = new ResumeHtmlRenderer();
  private readonly pdfRenderer?: PdfRendererAdapter;
  private readonly fitService: ResumeFitService;

  public constructor(
    private readonly repository: ResumeExportRepository,
    private readonly resumeService: ResumeService,
    private readonly fileService: FileService,
    private readonly platformServices: PlatformServices,
    pdfRenderer?: PdfRendererAdapter,
    layoutMeasurer?: ResumeLayoutMeasurer,
  ) {
    this.pdfRenderer = pdfRenderer;
    // Default to the deterministic heuristic so dev/test never need
    // Chromium just to compute fitReport. Production wiring can swap in
    // `PlaywrightLayoutMeasurer` via the `layoutMeasurer` argument.
    this.fitService = new ResumeFitService(layoutMeasurer ?? new HeuristicLayoutMeasurer());
  }

  public async createExport(userId: string, input: { resumeId: string; format: ResumeExportFormat; templateId?: string }): Promise<{ exportRecord: ResumeExport; job: Awaited<ReturnType<PlatformServices["backgroundJobs"]["createJob"]>>; workerDisabled?: boolean }> {
    if (input.format === "docx") throw new ApiError(ErrorCodes.INVALID_BODY, "DOCX export is not supported yet.", 400);
    if (input.format === "pdf" && readPlatformConfig().pdfRenderer === PDF_RENDERER_NONE) {
      throw new ApiError(
        ErrorCodes.INTERNAL_ERROR,
        "PDF renderer is not configured. Set PDF_RENDERER=playwright (and run `npx playwright install chromium`) to enable PDF export.",
        503,
      );
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
    const exportRecord = updated ?? record;
    const workerDisabled = !readPlatformConfig().jobWorkerEnabled;
    console.debug("[exports] createExport", {
      exportId: exportRecord.id,
      jobId: job.id,
      status: exportRecord.status,
      workerDisabled,
    });
    if (workerDisabled) {
      console.warn("[exports] worker disabled; export job will not render until a worker or dev fallback runs", {
        exportId: exportRecord.id,
        jobId: job.id,
      });
    }
    return { exportRecord, job, ...(workerDisabled ? { workerDisabled } : {}) };
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
    console.debug("[exports] renderExportJob start", { exportId, resumeId: record.resumeId, status: record.status });

    // Idempotency: if already completed and a fileId exists, return as-is.
    if (record.status === "completed" && record.fileId) {
      console.debug("[exports] renderExportJob already completed; returning existing record", { exportId });
      return record;
    }
    // If currently rendering, refuse to render concurrently — allow callers to
    // poll instead of producing duplicate files.
    if (record.status === "rendering") {
      console.debug("[exports] renderExportJob already in progress; skipping", { exportId });
      return record;
    }

    try {
      if (record.format === "pdf" && readPlatformConfig().pdfRenderer === PDF_RENDERER_NONE) {
        throw new ApiError(
          ErrorCodes.INTERNAL_ERROR,
          "PDF renderer is not configured. Set PDF_RENDERER=playwright (and run `npx playwright install chromium`) to enable PDF export.",
          503,
        );
      }
      const resume = await this.resumeService.getResume(userId, record.resumeId);
      if (!resume) throw new ApiError(ErrorCodes.NOT_FOUND, "Resume not found.", 404);
      // Reset error state when re-rendering a previously failed export, then
      // mark rendering as a soft lock.
      await this.repository.updateExport(userId, exportId, {
        status: "rendering",
        errorMessage: undefined,
      });
      const html = this.renderer.render(resume, record.templateId);

      // Phase 5 Fit Engine v1: measure the rendered HTML so the export
      // record can answer "did this resume fit on one page?" without a
      // re-render. Failures are logged but never block the export — Phase
      // 5 explicitly does NOT cause downstream work to fail just because
      // a measurement is unavailable. (Phase 6 will react to the report.)
      const fitReport = await this.measureFitReport(html, record);

      let fileBuffer: Buffer;
      let originalName: string;
      let mimeType: string;

      const safeTitle = sanitizeFilenameTitle(resume.title) || record.resumeId;

      if (record.format === "pdf") {
        fileBuffer = await this.renderPdf(html);
        originalName = `${safeTitle}.pdf`;
        mimeType = "application/pdf";
      } else {
        // HTML export
        fileBuffer = Buffer.from(html, "utf8");
        originalName = `${safeTitle}.html`;
        mimeType = "text/plain";
      }

      const file = await this.fileService.uploadFile(userId, {
        originalName,
        mimeType,
        buffer: fileBuffer,
      });
      const token = `dl_${randomBytes(24).toString("base64url")}`;
      const completed = await this.repository.updateExport(userId, exportId, {
        status: "completed",
        fileId: file.id,
        downloadTokenHash: createHash("sha256").update(token).digest("hex"),
        downloadExpiresAt: new Date(Date.now() + readDownloadTtlMinutes() * 60_000).toISOString(),
        completedAt: new Date().toISOString(),
        errorMessage: undefined,
        ...(fitReport ? { fitReport } : {}),
      });
      const finalRecord = completed ?? record;
      console.debug("[exports] renderExportJob done", {
        exportId,
        resumeId: finalRecord.resumeId,
        fileId: finalRecord.fileId,
        format: finalRecord.format,
        status: finalRecord.status,
        fitReport: fitReport
          ? {
              estimatedPages: fitReport.estimatedPages,
              overflowPx: fitReport.overflowPx,
              templateId: fitReport.templateId,
              density: fitReport.density,
              measurer: fitReport.measurer,
            }
          : undefined,
      });
      if (fitReport && fitReport.overflowPx > 0) {
        console.warn("[exports] resume overflows one A4 page (Phase 5: warn-only)", {
          exportId,
          resumeId: finalRecord.resumeId,
          estimatedPages: fitReport.estimatedPages,
          overflowPx: fitReport.overflowPx,
          templateId: fitReport.templateId,
          density: fitReport.density,
        });
      }
      return finalRecord;
    } catch (error) {
      const message = pdfErrorMessage(error);
      await this.markExportFailed(userId, exportId, message);
      console.error("[exports] renderExportJob fail", { exportId, resumeId: record.resumeId, error: message });
      // Preserve ApiError status codes for callers that translate them to HTTP.
      if (error instanceof ApiError) throw error;
      if (error instanceof PdfRenderError) {
        throw new ApiError(ErrorCodes.INTERNAL_ERROR, message, 500);
      }
      throw error;
    }
  }

  /**
   * Render an HTML payload to a PDF buffer using the configured renderer.
   * The renderer is resolved lazily so tests can run without playwright/chromium
   * by injecting a {@link PdfRendererAdapter}.
   */
  private async renderPdf(html: string): Promise<Buffer> {
    const renderer = this.resolvePdfRenderer();
    return renderer.render(html);
  }

  /**
   * Phase 5: measure the rendered HTML and return a `ResumeFitReport`.
   * Returns `undefined` when measurement fails — measurement is best-effort
   * and must NEVER cause the export to fail.
   */
  private async measureFitReport(
    html: string,
    record: ResumeExport,
  ): Promise<ResumeFitReport | undefined> {
    const templateId = record.templateId ?? "default";
    const density = resolveDensityFromHtml(html);
    try {
      return await this.fitService.measure({ html, templateId, density });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof ResumeFitMeasureError) {
        console.warn("[exports] fit measurement failed (will skip fitReport)", { exportId: record.id, error: message });
      } else {
        console.warn("[exports] fit measurement threw unexpectedly (will skip fitReport)", { exportId: record.id, error: message });
      }
      return undefined;
    }
  }

  private resolvePdfRenderer(): PdfRendererAdapter {
    if (this.pdfRenderer) return this.pdfRenderer;
    const config = readPlatformConfig();
    if (config.pdfRenderer === PDF_RENDERER_PLAYWRIGHT) {
      return new PlaywrightPdfRenderer();
    }
    // Note: createExport / renderExportJob already short-circuit when
    // pdfRenderer === "none". We end up here only if config is "external"
    // (not yet implemented) or some unknown value slipped through.
    throw new ApiError(
      ErrorCodes.INTERNAL_ERROR,
      `PDF renderer "${config.pdfRenderer}" is not implemented. Set PDF_RENDERER=playwright or inject a custom adapter.`,
      503,
    );
  }

  public async markExportFailed(userId: string, exportId: string, errorMessage: string): Promise<ResumeExport | null> {
    return this.repository.updateExport(userId, exportId, {
      status: "failed",
      errorMessage,
      completedAt: new Date().toISOString(),
    });
  }

  public async readDownload(userId: string, id: string): Promise<{ exportRecord: ResumeExport; fileText: string; fileBuffer?: Buffer }> {
    const record = await this.repository.getExport(userId, id);
    if (!record || record.status !== "completed" || !record.fileId) {
      throw new ApiError(ErrorCodes.NOT_FOUND, "Export is not ready.", 404);
    }
    if (record.format === "pdf") {
      const buffer = await this.fileService.getRawBuffer(userId, record.fileId);
      return { exportRecord: record, fileText: "", fileBuffer: buffer };
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

function pdfErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof PdfRenderError) return error.message;
  return error instanceof Error ? error.message : "Export render failed.";
}

function sanitizeFilenameTitle(title: string | undefined): string {
  if (!title) return "";
  // Keep unicode, but strip path separators / control / quote chars that break
  // content-disposition or filesystem paths.
  return title
    .replace(/[\\/:*?"<>| -]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/**
 * Resolve the active density label for `fitReport`. We read the value the
 * template baked into the rendered HTML (`data-density="..."`) so a
 * measurer never disagrees with what was actually rendered. Falls back to
 * `"standard"` for templates that do not emit the attribute (e.g. the
 * legacy default template).
 */
function resolveDensityFromHtml(html: string): string {
  const match = /data-density="([^"]+)"/.exec(html);
  if (match && match[1]) return match[1];
  return "standard";
}
