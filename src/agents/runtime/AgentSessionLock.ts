import type { ApiKernel } from "../../api/types.js";
import { ApiError, ErrorCodes } from "../../api/errors.js";
import type { KernelRequestContext } from "../../kernel/context.js";
import { readPlatformConfig } from "../../platform/index.js";

export class AgentSessionLock {
  public constructor(private readonly kernel: ApiKernel) {}

  public async acquire(ctx: KernelRequestContext, sessionId: string): Promise<void> {
    const acquired = await this.kernel.platformServices.sessionLocks.acquire({
      userId: ctx.user.id,
      sessionId,
      ownerRequestId: ctx.request.requestId,
      ttlMs: readPlatformConfig().sessionLockTtlMs,
    });
    if (!acquired) {
      throw new ApiError(ErrorCodes.SESSION_LOCKED, "This session is already processing another request. Please retry shortly.", 409, { retryable: true });
    }
  }

  public async release(ctx: KernelRequestContext, sessionId: string): Promise<void> {
    await this.kernel.platformServices.sessionLocks.release({
      userId: ctx.user.id,
      sessionId,
      ownerRequestId: ctx.request.requestId,
    });
  }
}
