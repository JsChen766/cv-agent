import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FileService } from "../files/index.js";
import type { PlatformServices } from "../platform/index.js";
import { readPlatformConfig } from "../platform/config.js";
import type { ResumeService } from "../product/index.js";
import type { ProductResumeDetail, ProductResumeItem } from "../product/types.js";
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
import {
  ResumeCompressionService,
  type ResumeCompressionReport,
} from "./ResumeCompressionService.js";
import {
  ResumeLLMFitEditor,
  type ResumeFitEditorReport,
} from "./ResumeLLMFitEditor.js";
import { PromptRegistry } from "../agent-core/prompts/PromptRegistry.js";
import type { ModelClient } from "../agent-core/model/ModelClient.js";
import type { ResumeExport, ResumeExportFormat } from "./types.js";

const PDF_RENDERER_NONE = "none";
const PDF_RENDERER_PLAYWRIGHT = "playwright";

export class ResumeExportService {
  private readonly renderer = new ResumeHtmlRenderer();
  private readonly pdfRenderer?: PdfRendererAdapter;
  private readonly fitService: ResumeFitService;
  private readonly compressionService = new ResumeCompressionService();
  private readonly promptRegistry = new PromptRegistry();
  private readonly modelClient?: ModelClient;

  public constructor(
    private readonly repository: ResumeExportRepository,
    private readonly resumeService: ResumeService,
    private readonly fileService: FileService,
    private readonly platformServices: PlatformServices,
    pdfRenderer?: PdfRendererAdapter,
    layoutMeasurer?: ResumeLayoutMeasurer,
    modelClient?: ModelClient,
  ) {
    this.pdfRenderer = pdfRenderer;
    this.modelClient = modelClient;
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
      // a measurement is unavailable. (Phase 6 reacts to the report.)
      const initialFitReport = await this.measureFitReport(html, record);

      // Phase 6 Fit Engine v2: when the resume overflows one A4 page on
      // the `one-page-modern` template, run rule-based compression on a
      // clone of the items, re-render with the compressed snapshot, and
      // re-measure. Phase 6 inherits Phase 5's "warn-only on overflow"
      // contract: compression is best-effort and never fails the export.
      const compressionOutput = await this.maybeCompress(resume, html, record, initialFitReport);
      let finalHtml = compressionOutput.html;
      let finalFitReport = compressionOutput.fitReport;
      const compressionReport = compressionOutput.compressionReport;

      // Phase 7 Fit Engine v3: when Phase 6 compression ran but the
      // resume STILL overflows, OR Phase 6 was bypassed and the page
      // has a large underflow, hand the items to the LLM Resume Fit
      // Editor for structured edits. Opt-in via ENABLE_LLM_FIT_EDITOR
      // and a configured model client. Best-effort: never fails the export.
      const editOutput = await this.maybeLlmFitEdit(
        resume,
        finalHtml,
        record,
        finalFitReport,
        compressionReport,
      );
      finalHtml = editOutput.html;
      finalFitReport = editOutput.fitReport;
      const editReport = editOutput.editReport;

      let fileBuffer: Buffer;
      let originalName: string;
      let mimeType: string;

      const safeTitle = sanitizeFilenameTitle(resume.title) || record.resumeId;

      if (record.format === "pdf") {
        fileBuffer = await this.renderPdf(finalHtml);
        originalName = `${safeTitle}.pdf`;
        mimeType = "application/pdf";
      } else {
        // HTML export
        fileBuffer = Buffer.from(finalHtml, "utf8");
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
        ...(finalFitReport ? { fitReport: finalFitReport } : {}),
        ...(compressionReport ? { compressionReport } : {}),
        ...(editReport ? { editReport } : {}),
      });
      const finalRecord = completed ?? record;
      console.debug("[exports] renderExportJob done", {
        exportId,
        resumeId: finalRecord.resumeId,
        fileId: finalRecord.fileId,
        format: finalRecord.format,
        status: finalRecord.status,
        fitReport: finalFitReport
          ? {
              estimatedPages: finalFitReport.estimatedPages,
              overflowPx: finalFitReport.overflowPx,
              templateId: finalFitReport.templateId,
              density: finalFitReport.density,
              measurer: finalFitReport.measurer,
            }
          : undefined,
        compression: compressionReport
          ? {
              applied: compressionReport.applied,
              actions: compressionReport.actions.length,
              iterations: compressionReport.iterations,
              stillOverflowing: compressionReport.stillOverflowing,
              densityBefore: compressionReport.densityBefore,
              densityAfter: compressionReport.densityAfter,
            }
          : undefined,
      });
      if (compressionReport && compressionReport.stillOverflowing) {
        console.warn("[exports] resume still overflows one A4 page after Phase 6 compression (warn-only)", {
          exportId,
          resumeId: finalRecord.resumeId,
          finalEstimatedPages: compressionReport.finalEstimatedPages,
          finalOverflowPx: compressionReport.finalOverflowPx,
          actions: compressionReport.actions.length,
          reason: compressionReport.reason,
        });
      } else if (!compressionReport && finalFitReport && finalFitReport.overflowPx > 0) {
        // Compression bypassed (different template or non-1 targetPages)
        // but the resume still overflows — keep the Phase 5 warning so the
        // bypass case is still observable.
        console.warn("[exports] resume overflows one A4 page (compression bypassed)", {
          exportId,
          resumeId: finalRecord.resumeId,
          estimatedPages: finalFitReport.estimatedPages,
          overflowPx: finalFitReport.overflowPx,
          templateId: finalFitReport.templateId,
          density: finalFitReport.density,
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

  /**
   * Phase 6 Fit Engine v2: when the initial measurement says the resume
   * overflows one A4 page on the `one-page-modern` template, hand the
   * items to `ResumeCompressionService` which mutates a clone via the
   * priority strategies (drop optional bullets → shorten → hide low
   * relevance → drop density). Each mutation is re-measured by
   * re-rendering with the compressed snapshot.
   *
   * Returns the final HTML to ship plus the (possibly updated) fitReport
   * and a `compressionReport` describing what changed. Compression is
   * best-effort: any error is swallowed and the original html/fitReport
   * are returned unchanged.
   */
  private async maybeCompress(
    resume: ProductResumeDetail,
    initialHtml: string,
    record: ResumeExport,
    initialFitReport: ResumeFitReport | undefined,
  ): Promise<{ html: string; fitReport: ResumeFitReport | undefined; compressionReport: ResumeCompressionReport | undefined }> {
    if (!initialFitReport) return { html: initialHtml, fitReport: undefined, compressionReport: undefined };
    if (initialFitReport.overflowPx <= 0) return { html: initialHtml, fitReport: initialFitReport, compressionReport: undefined };
    const templateId = record.templateId ?? initialFitReport.templateId;
    if (templateId !== "one-page-modern") {
      return { html: initialHtml, fitReport: initialFitReport, compressionReport: undefined };
    }
    if (initialFitReport.targetPages !== 1) {
      return { html: initialHtml, fitReport: initialFitReport, compressionReport: undefined };
    }

    try {
      const measure = async (items: ProductResumeItem[], density: string): Promise<ResumeFitReport> => {
        const synthetic = withDensity(resume, items, density);
        const nextHtml = this.renderer.render(synthetic, templateId);
        return this.fitService.measure({ html: nextHtml, templateId, density });
      };
      const result = await this.compressionService.compress({
        items: resume.items,
        density: initialFitReport.density,
        initialFitReport,
        measure,
      });
      // Render once more with the final state so the caller has the
      // exact bytes the file should contain.
      const synthetic = withDensity(resume, result.items, result.density);
      const finalHtml = this.renderer.render(synthetic, templateId);
      // Use the recorded fitReport if we believe it (i.e. compression
      // ran and updated it via at least one measure() call). Otherwise
      // fall back to the initial fitReport.
      const fitReport = result.compressionReport.applied ? result.fitReport : initialFitReport;
      return { html: finalHtml, fitReport, compressionReport: result.compressionReport };
    } catch (error) {
      console.warn("[exports] resume compression threw unexpectedly (will skip compressionReport)", {
        exportId: record.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return { html: initialHtml, fitReport: initialFitReport, compressionReport: undefined };
    }
  }

  /**
   * Phase 7 Fit Engine v3: when Phase 6 compression ran but the page
   * still overflows OR the page is significantly underfilled and Phase 6
   * was bypassed, ask the LLM Resume Fit Editor for structured edits.
   *
   * Triggers ONLY for the `one-page-modern` template at targetPages=1
   * AND when {@link ResumeLLMFitEditor.shouldTrigger} reports a trigger.
   * Opt-in: requires `ENABLE_LLM_FIT_EDITOR=true` AND a configured
   * `modelClient`; otherwise we skip and return inputs unchanged.
   *
   * Like Phase 5/6 this is best-effort: any error is swallowed and the
   * caller receives the unmodified html/fitReport/editReport=undefined.
   */
  private async maybeLlmFitEdit(
    resume: ProductResumeDetail,
    currentHtml: string,
    record: ResumeExport,
    currentFitReport: ResumeFitReport | undefined,
    compressionReport: ResumeCompressionReport | undefined,
  ): Promise<{ html: string; fitReport: ResumeFitReport | undefined; editReport: ResumeFitEditorReport | undefined }> {
    const unchanged = { html: currentHtml, fitReport: currentFitReport, editReport: undefined as ResumeFitEditorReport | undefined };
    if (process.env.ENABLE_LLM_FIT_EDITOR !== "true") return unchanged;
    if (!this.modelClient) return unchanged;
    if (!currentFitReport) return unchanged;
    const templateId = record.templateId ?? currentFitReport.templateId;
    if (templateId !== "one-page-modern") return unchanged;
    if (currentFitReport.targetPages !== 1) return unchanged;

    let systemPrompt: string;
    try {
      systemPrompt = this.promptRegistry.get("product.resumeFitEditor.system");
    } catch (error) {
      console.warn("[exports] resume fit editor system prompt missing (will skip)", {
        exportId: record.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return unchanged;
    }

    const modelClient = this.modelClient;
    const editor = new ResumeLLMFitEditor({
      prompt: systemPrompt,
      chat: async ({ systemPrompt: sys, userPayload }) => {
        const response = await modelClient.chat({
          messages: [
            { role: "system", content: sys },
            { role: "user", content: userPayload },
          ],
          responseFormat: "json",
          temperature: 0,
        });
        return { content: response.content };
      },
    });

    const trigger = editor.shouldTrigger(currentFitReport, compressionReport);
    if (!trigger) return unchanged;

    try {
      const measure = async (items: ProductResumeItem[], density: string): Promise<ResumeFitReport> => {
        const synthetic = withDensity(resume, items, density);
        const nextHtml = this.renderer.render(synthetic, templateId);
        return this.fitService.measure({ html: nextHtml, templateId, density });
      };
      const result = await editor.edit({
        items: resume.items,
        density: currentFitReport.density,
        fitReport: currentFitReport,
        compressionReport,
        measure,
      });
      if (!result.editReport.applied) {
        return { html: currentHtml, fitReport: currentFitReport, editReport: result.editReport };
      }
      const synthetic = withDensity(resume, result.items, result.density);
      const nextHtml = this.renderer.render(synthetic, templateId);
      const nextFitReport = result.fitReport ?? currentFitReport;
      return { html: nextHtml, fitReport: nextFitReport, editReport: result.editReport };
    } catch (error) {
      console.warn("[exports] resume LLM fit editor threw unexpectedly (will skip editReport)", {
        exportId: record.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return unchanged;
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

/**
 * Build a synthetic ProductResumeDetail with the compression service's
 * chosen items and density baked in. We do NOT mutate the source resume
 * — the original DB rows must stay byte-identical to what the user saved.
 *
 * `metadata.density` is read by `onePageModernTemplate.pickDensity`. The
 * template type doesn't have a static `metadata` field on `ProductResume`
 * (today it's only consulted via a structural cast inside the template),
 * so we attach it via cast here.
 */
function withDensity(
  resume: ProductResumeDetail,
  items: ProductResumeItem[],
  density: string,
): ProductResumeDetail {
  const synthetic: ProductResumeDetail = {
    ...resume,
    items,
  };
  (synthetic as unknown as { metadata: Record<string, unknown> }).metadata = {
    ...((resume as unknown as { metadata?: Record<string, unknown> }).metadata ?? {}),
    density,
  };
  return synthetic;
}
