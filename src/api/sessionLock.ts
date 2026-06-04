import { ApiError, ErrorCodes } from "./errors.js";
import type { KernelRequestContext } from "./context.js";
import type { ApiKernel } from "./types.js";

export async function withSessionLock<T>(
  kernel: ApiKernel,
  ctx: KernelRequestContext,
  sessionId: string | undefined,
  handler: () => Promise<T>,
): Promise<T> {
  if (!sessionId) return handler();
  let acquired = false;
  try {
    acquired = await kernel.platformServices.sessionLocks.acquire({
      userId: ctx.user.id,
      sessionId,
      ownerRequestId: ctx.request.requestId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[session-lock] acquire failed", {
      userId: ctx.user.id,
      sessionId,
      requestId: ctx.request.requestId,
      error: message,
    });
    return handler();
  }
  if (!acquired) {
    throw new ApiError(ErrorCodes.SESSION_LOCKED, "This session is processing another request. Please retry shortly.", 409, { retryable: true });
  }
  try {
    return await handler();
  } finally {
    try {
      await kernel.platformServices.sessionLocks.release({
        userId: ctx.user.id,
        sessionId,
        ownerRequestId: ctx.request.requestId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[session-lock] release failed", {
        userId: ctx.user.id,
        sessionId,
        requestId: ctx.request.requestId,
        error: message,
      });
    }
  }
}
