import type { ResumeExportService } from "../exports/index.js";
import type { FileService } from "../files/index.js";
import type { BackgroundJob, PlatformServices } from "../platform/index.js";
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
      await this.deps.platformServices.backgroundJobs.markFailed(job.userId, job.id, `No handler registered for job type ${job.type}.`);
      return;
    }
    await this.deps.platformServices.backgroundJobs.markProgress(job.userId, job.id, 10, "Job started.");
    try {
      await this.deps.platformServices.backgroundJobs.markProgress(job.userId, job.id, 30, "Processing.");
      const output = await handler({ job });
      const current = await this.deps.platformServices.backgroundJobs.getJob(job.userId, job.id);
      if (current?.status === "cancelled") return;
      await this.deps.platformServices.backgroundJobs.markCompleted(job.userId, job.id, output);
    } catch (error) {
      const current = await this.deps.platformServices.backgroundJobs.getJob(job.userId, job.id);
      if (current?.status === "cancelled") return;
      const message = error instanceof Error ? error.message : "Job failed.";
      if (job.attempts < job.maxAttempts) {
        await this.deps.platformServices.backgroundJobs.scheduleRetry(job.userId, job.id, message, new Date(Date.now() + 1000 * Math.max(1, job.attempts)).toISOString());
      } else {
        await this.deps.platformServices.backgroundJobs.markFailed(job.userId, job.id, message);
      }
    }
  }
}

function stringInput(input: Record<string, unknown> | undefined, key: string): string {
  const value = input?.[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required.`);
  return value;
}
