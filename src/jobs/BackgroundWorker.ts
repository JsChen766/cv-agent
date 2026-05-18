import type { BackgroundJobType } from "../platform/index.js";
import type { ApiKernel } from "../api/types.js";
import { readPlatformConfig } from "../platform/config.js";

export class BackgroundWorker {
  private stopped = false;

  public constructor(
    private readonly kernel: ApiKernel,
    private readonly workerId = `worker-${process.pid}`,
  ) {}

  public async start(types?: BackgroundJobType[]): Promise<void> {
    this.stopped = false;
    const concurrency = readPlatformConfig().jobWorkerConcurrency;
    const workers = Array.from({ length: concurrency }, () => this.loop(types));
    await Promise.all(workers);
  }

  public stop(): void {
    this.stopped = true;
  }

  private async loop(types?: BackgroundJobType[]): Promise<void> {
    while (!this.stopped) {
      const job = await this.kernel.platformServices.backgroundJobs.claimNextJob(this.workerId, types);
      if (job) {
        await this.kernel.jobRunner.runJob(job.id, job.userId);
      } else {
        await new Promise((resolve) => setTimeout(resolve, readPlatformConfig().jobPollIntervalMs));
      }
    }
  }
}
