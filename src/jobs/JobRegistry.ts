import type { BackgroundJob, BackgroundJobType } from "../platform/index.js";

export type JobHandlerContext = {
  job: BackgroundJob;
};

export type JobHandler = (ctx: JobHandlerContext) => Promise<Record<string, unknown> | undefined>;

export class JobRegistry {
  private readonly handlers = new Map<BackgroundJobType, JobHandler>();

  public register(type: BackgroundJobType, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  public get(type: BackgroundJobType): JobHandler | undefined {
    return this.handlers.get(type);
  }
}
