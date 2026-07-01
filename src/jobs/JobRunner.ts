import type { ResumeExportService } from "../exports/index.js";
import type { FileService } from "../files/index.js";
import type { BackgroundJob, PlatformServices } from "../platform/index.js";
import type { ProductServices } from "../product/index.js";
import type { PendingActionService } from "../agent-core/confirmation/PendingActionService.js";
import type { ToolResult } from "../agent-core/tools/ToolResult.js";
import type { CopilotSessionService, CopilotWorkspaceService } from "../copilot/services/index.js";
import type { CopilotWorkspace, ProductVariant } from "../copilot/types.js";
import type { ProductGeneratedVariant, ProductJDRecord } from "../product/types.js";
import { toWorkspaceVariant } from "../agent-tools/resume/helpers.js";
import { JobRegistry } from "./JobRegistry.js";

export type JobRunnerCopilotServices = {
  sessionService: CopilotSessionService;
  workspaceService: CopilotWorkspaceService;
};

export type JobRunnerDeps = {
  platformServices: PlatformServices;
  fileService: FileService;
  productServices: ProductServices;
  pendingActions: PendingActionService;
  getExportService(): ResumeExportService;
  copilotServices?: JobRunnerCopilotServices;
};

export class JobRunner {
  public readonly registry = new JobRegistry();

  public constructor(private readonly deps: JobRunnerDeps) {
    this.registry.register("parse_document", async ({ job }) => {
      const fileId = stringInput(job.input, "fileId");
      const document = await this.deps.fileService.parseFile(job.userId, fileId);
      return { parsedDocumentId: document.id, fileId };
    });
    this.registry.register("import_resume_file", async ({ job }) => {
      const fileId = stringInput(job.input, "fileId");
      const file = await this.deps.fileService.getFile(job.userId, fileId);
      if (!file) {
        throw new Error(`File ${fileId} not found. It may have been deleted before the import job ran.`);
      }
      const parsed = await this.deps.fileService.getParsedDocumentByFileId(job.userId, fileId)
        ?? await this.deps.fileService.parseFile(job.userId, fileId);
      const text = parsed.text?.trim() ?? "";
      if (!text) {
        throw new Error(`Parsed document for file ${fileId} is empty. The file may be unreadable, scanned, or contain no extractable text. Please upload a text-based PDF, DOCX, or TXT file.`);
      }
      const importJob = await this.deps.productServices.importService.createTextImportJob(job.userId, parsed.text, {
        sourceType: file.mimeType === "application/pdf" ? "pdf" : "text",
      });
      try {
        const candidates = await this.deps.productServices.importService.createCandidatesFromText(job.userId, importJob.id, {
          sourceDocumentId: parsed.id,
        });
        console.debug("[jobs] import_resume_file extracted candidates", {
          fileId,
          originalName: file.originalName,
          mimeType: file.mimeType,
          pageCount: parsed.metadata?.pageCount,
          textLength: parsed.text.length,
          candidateCount: candidates.length,
        });
        return { importJobId: importJob.id, candidateCount: candidates.length, fileId, parsedDocumentId: parsed.id };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Experience extraction failed.";
        // Surface a clear, user-readable error and keep the importJobId so the
        // frontend can still link to a failed import job for diagnostics.
        throw new Error(`Failed to extract experiences from file ${fileId} (importJobId=${importJob.id}): ${message}`);
      }
    });
    this.registry.register("import_resume_text", async ({ job }) => {
      const importJobId = stringInput(job.input, "importJobId");
      try {
        const candidates = await this.deps.productServices.importService.createCandidatesFromText(job.userId, importJobId);
        return { importJobId, candidateCount: candidates.length };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Experience extraction failed.";
        await this.deps.productServices.importService.markImportJobFailed(job.userId, importJobId, message);
        throw new Error(`Failed to extract experiences from text import ${importJobId}: ${message}`);
      }
    });
    this.registry.register("long_generation", async ({ job }) => {
      const actionType = stringInput(job.input, "actionType");
      if (actionType !== "generate_resume_from_jd") {
        throw new Error(`Unsupported long_generation actionType ${actionType}.`);
      }
      const toolArguments = recordInput(job.input, "toolArguments");
      const sessionId = stringInputOrUndefined(job.input, "sessionId");
      const result = await this.deps.productServices.generationProductService.generateResumeFromJD({
        userId: job.userId,
        sessionId,
        jdId: stringInputOrUndefined(toolArguments, "jdId"),
        jdText: stringInputOrUndefined(toolArguments, "jdText"),
        targetRole: stringInputOrUndefined(toolArguments, "targetRole"),
      });
      const workspaceVariants = result.variants.map(
        (variant, index) => toWorkspaceVariant(variant, result.jd, result.generation.id, index),
      );
      const activeVariantId = workspaceVariants[0]?.id;
      // Persist generation result back into the copilot session workspace so that
      // GET /copilot/sessions/:id reflects completed state after refresh.
      await this.persistGenerationWorkspace(job.userId, sessionId, {
        generationId: result.generation.id,
        jdId: result.jd.id,
        activeVariantId,
        variants: workspaceVariants,
      });
      const output = {
        actionType,
        generationId: result.generation.id,
        jdId: result.jd.id,
        variantCount: result.variants.length,
        activeVariantId,
        variants: result.variants,
      };
      const pendingActionId = stringInputOrUndefined(job.input, "pendingActionId");
      if (pendingActionId) {
        await this.deps.pendingActions.markExecuted(job.userId, pendingActionId, buildGenerationSuccessResult({
          generationId: result.generation.id,
          jdId: result.jd.id,
          activeVariantId,
          variants: workspaceVariants,
          rawVariants: result.variants,
          jd: result.jd,
          generation: result.generation,
        }));
      }
      return output;
    });
    this.registry.register("rebuild_index", async ({ job }) => {
      const service = this.deps.productServices.evidenceRAGService;
      if (!service) throw new Error("Evidence RAG is not configured.");
      const report = await service.reindexUserExperiences({
        userId: job.userId,
        limit: numberInputOrUndefined(job.input, "limit"),
      });
      if (!report) throw new Error("Persistent claim indexing is not configured.");
      return { ...report };
    });
    this.registry.register("export_resume_html", async ({ job }) => {
      const exportId = stringInput(job.input, "exportId");
      const exportRecord = await this.deps.getExportService().renderExportJob(job.userId, exportId);
      return { exportId: exportRecord.id, fileId: exportRecord.fileId };
    });
    this.registry.register("export_resume_pdf", async ({ job }) => {
      const exportId = stringInput(job.input, "exportId");
      const exportRecord = await this.deps.getExportService().renderExportJob(job.userId, exportId);
      return { exportId: exportRecord.id, fileId: exportRecord.fileId };
    });
  }

  /** Test/compat path: looks up job by id before running. Sets running state if not already running. */
  public async runJob(jobId: string, userId: string): Promise<void> {
    const job = await this.deps.platformServices.backgroundJobs.getJob(userId, jobId);
    if (!job || job.status === "cancelled") return;
    // If job was already claimed (running), don't double-bump attempts
    const toRun = job.status !== "running"
      ? (await this.deps.platformServices.backgroundJobs.markRunning(userId, jobId)) ?? job
      : job;
    return this.executeJob(toRun);
  }

  /** Worker path: uses an already-claimed job object directly (attempts already bumped by claimNextJob). */
  public async runClaimedJob(job: BackgroundJob, _workerId: string): Promise<void> {
    if (job.status === "cancelled") return;
    return this.executeJob(job);
  }

  private async executeJob(job: BackgroundJob): Promise<void> {
    const handler = this.registry.get(job.type);
    if (!handler) {
      const message = `No handler registered for job type ${job.type}.`;
      await this.markExportFailedForJob(job, message);
      await this.markGenerationFailedForJob(job, message);
      await this.deps.platformServices.backgroundJobs.markFailed(job.userId, job.id, message);
      return;
    }
    console.debug("[jobs] start", { jobId: job.id, type: job.type, attempts: job.attempts });
    await this.deps.platformServices.backgroundJobs.markProgress(job.userId, job.id, 10, "Job started.");
    try {
      await this.deps.platformServices.backgroundJobs.markProgress(job.userId, job.id, 30, "Processing.");
      const output = await handler({ job });
      const current = await this.deps.platformServices.backgroundJobs.getJob(job.userId, job.id);
      if (current?.status === "cancelled") return;
      await this.deps.platformServices.backgroundJobs.markCompleted(job.userId, job.id, output);
      console.debug("[jobs] done", { jobId: job.id, type: job.type, output });
    } catch (error) {
      const current = await this.deps.platformServices.backgroundJobs.getJob(job.userId, job.id);
      if (current?.status === "cancelled") return;
      const message = error instanceof Error ? error.message : "Job failed.";
      await this.markExportFailedForJob(job, message);
      console.error("[jobs] fail", { jobId: job.id, type: job.type, error: message });
      if (job.attempts < job.maxAttempts) {
        await this.deps.platformServices.backgroundJobs.scheduleRetry(job.userId, job.id, message, new Date(Date.now() + 1000 * Math.max(1, job.attempts)).toISOString());
      } else {
        await this.markGenerationFailedForJob(job, message);
        await this.deps.platformServices.backgroundJobs.markFailed(job.userId, job.id, message);
      }
    }
  }

  private async markExportFailedForJob(job: BackgroundJob, message: string): Promise<void> {
    if (job.type !== "export_resume_html" && job.type !== "export_resume_pdf") return;
    const exportId = stringInputOrUndefined(job.input, "exportId");
    if (!exportId) return;
    try {
      await this.deps.getExportService().markExportFailed(job.userId, exportId, message);
    } catch (error) {
      console.error("[jobs] export failure sync failed", {
        jobId: job.id,
        exportId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async markGenerationFailedForJob(job: BackgroundJob, message: string): Promise<void> {
    if (job.type !== "long_generation") return;
    const pendingActionId = stringInputOrUndefined(job.input, "pendingActionId");
    if (!pendingActionId) return;
    try {
      await this.deps.pendingActions.markFailed(job.userId, pendingActionId, {
        status: "failed",
        message,
        data: {
          jobId: job.id,
          actionType: stringInputOrUndefined(job.input, "actionType") ?? "generate_resume_from_jd",
        },
        actionResult: {
          actionType: "generate_resume_from_jd",
          status: "failed",
          reason: "generation_job_failed",
          message,
          metadata: {
            jobId: job.id,
            jobStatus: "failed",
          },
        },
        visibility: "error_user_visible",
      });
    } catch (error) {
      console.error("[jobs] generation failure sync failed", {
        jobId: job.id,
        pendingActionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async persistGenerationWorkspace(userId: string, sessionId: string | undefined, input: {
    generationId: string;
    jdId: string;
    activeVariantId: string | undefined;
    variants: ProductVariant[];
  }): Promise<void> {
    if (!sessionId) return;
    const copilotServices = this.deps.copilotServices;
    if (!copilotServices) return;
    try {
      const existing = await copilotServices.workspaceService.getWorkspace(userId, sessionId);
      const now = new Date().toISOString();
      const base: CopilotWorkspace = existing ?? {
        id: `ws-${sessionId}`,
        sessionId,
        variants: [],
        status: "empty",
        updatedAt: now,
      };
      const merged: CopilotWorkspace = {
        ...base,
        activePanel: "variants",
        productGenerationId: input.generationId,
        jdId: input.jdId,
        activeVariantId: input.activeVariantId ?? null,
        variants: input.variants,
        status: "ready",
        summary: `已生成 ${input.variants.length} 个简历版本，请选择一个版本保存为简历。`,
        active: {
          ...(base.active ?? {}),
          jdId: input.jdId,
          variantId: input.activeVariantId,
        },
        updatedAt: now,
      };
      await copilotServices.workspaceService.saveWorkspace(userId, merged);
    } catch (error) {
      console.error("[jobs] persist generation workspace failed", {
        userId,
        sessionId,
        generationId: input.generationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function buildGenerationSuccessResult(input: {
  generationId: string;
  jdId: string;
  activeVariantId?: string;
  variants: ProductVariant[];
  rawVariants: ProductGeneratedVariant[];
  jd: ProductJDRecord;
  generation: unknown;
}): ToolResult {
  return {
    status: "success",
    message: "简历版本已生成，请选择一个版本保存为简历。",
    data: {
      generationId: input.generationId,
      jd: input.jd,
      variants: input.variants,
      generation: input.generation,
    },
    workspacePatch: {
      activePanel: "variants",
      status: "ready",
      productGenerationId: input.generationId,
      jdId: input.jdId,
      activeVariantId: input.activeVariantId,
      variants: input.variants,
      summary: `已生成 ${input.variants.length} 个简历版本，请选择一个版本保存为简历。`,
    },
    actionResult: {
      actionType: "generate_resume_from_jd",
      status: "success",
      message: "简历版本已生成，请选择一个版本保存为简历。",
      metadata: {
        generationId: input.generationId,
        variantCount: input.variants.length,
        activeVariantId: input.activeVariantId,
        jdId: input.jdId,
      },
    },
    visibility: "user_summary",
  };
}

function stringInput(input: Record<string, unknown> | undefined, key: string): string {
  const value = input?.[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required.`);
  return value;
}

function stringInputOrUndefined(input: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = input?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function recordInput(input: Record<string, unknown> | undefined, key: string): Record<string, unknown> {
  const value = input?.[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${key} is required.`);
  return value as Record<string, unknown>;
}

function numberInputOrUndefined(input: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = input?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
