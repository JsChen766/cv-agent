import type { ResumeExportService } from "../exports/index.js";
import type { FileService } from "../files/index.js";
import type { PlatformServices } from "../platform/index.js";
import type { ProductServices } from "../product/index.js";
import { JobRegistry } from "./JobRegistry.js";

export type JobRunnerDeps = {
  platformServices: PlatformServices;
  fileService: FileService;
  productServices: ProductServices;
  getExportService(): ResumeExportService;
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
      const parsed = await this.deps.fileService.getParsedDocumentByFileId(job.userId, fileId)
        ?? await this.deps.fileService.parseFile(job.userId, fileId);
      const importJob = await this.deps.productServices.importService.createTextImportJob(job.userId, parsed.text);
      const candidates = await this.deps.productServices.importService.createCandidatesFromText(job.userId, importJob.id);
      return { importJobId: importJob.id, candidateCount: candidates.length };
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

  public async runJob(jobId: string, userId: string): Promise<void> {
    const job = await this.deps.platformServices.backgroundJobs.getJob(userId, jobId);
    if (!job || job.status === "cancelled") return;
    const handler = this.registry.get(job.type);
    if (!handler) {
      await this.deps.platformServices.backgroundJobs.markFailed(userId, jobId, `No handler registered for job type ${job.type}.`);
      return;
    }
    await this.deps.platformServices.backgroundJobs.markProgress(userId, jobId, 10, "Job started.");
    try {
      await this.deps.platformServices.backgroundJobs.markProgress(userId, jobId, 30, "Processing.");
      const output = await handler({ job });
      // Re-check: job may have been cancelled during handler execution
      const current = await this.deps.platformServices.backgroundJobs.getJob(userId, jobId);
      if (current?.status === "cancelled") return;
      await this.deps.platformServices.backgroundJobs.markCompleted(userId, jobId, output);
    } catch (error) {
      const current = await this.deps.platformServices.backgroundJobs.getJob(userId, jobId);
      if (current?.status === "cancelled") return;
      const message = error instanceof Error ? error.message : "Job failed.";
      if (job.attempts < job.maxAttempts) {
        await this.deps.platformServices.backgroundJobs.scheduleRetry(userId, jobId, message, new Date(Date.now() + 1000 * Math.max(1, job.attempts)).toISOString());
      } else {
        await this.deps.platformServices.backgroundJobs.markFailed(userId, jobId, message);
      }
    }
  }
}

function stringInput(input: Record<string, unknown> | undefined, key: string): string {
  const value = input?.[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required.`);
  return value;
}
