import type { ApiKernel } from "../../api/types.js";
import { ApiError, ErrorCodes } from "../../api/errors.js";
import type { CopilotChatRequest } from "../../copilot/types.js";
import { readPlatformConfig } from "../../platform/index.js";

export class AgentQuotaGuard {
  public constructor(private readonly kernel: ApiKernel) {}

  public assertPromptWithinLimit(request: CopilotChatRequest): void {
    const length = [request.message, request.resumeText, request.jdText, request.targetRole].filter(Boolean).join("\n").length;
    if (length > readPlatformConfig().maxPromptChars) {
      throw new ApiError(ErrorCodes.QUOTA_EXCEEDED, "Input is too long for a single agent run.", 429, { retryable: false });
    }
  }

  public async consumeMessage(userId: string): Promise<void> {
    await this.kernel.platformServices.usage.consume({ userId, metric: "message" });
  }

  public async consumeToolCall(userId: string): Promise<void> {
    await this.kernel.platformServices.usage.consume({ userId, metric: "tool_call" });
  }

  public async consumeGeneration(userId: string): Promise<void> {
    await this.kernel.platformServices.usage.consume({ userId, metric: "generation" });
  }

  public isOverMaxToolCalls(count: number): boolean {
    return count > readPlatformConfig().maxToolCallsPerRun;
  }
}
