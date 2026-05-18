import type { ApiKernel } from "../../api/types.js";
import type { CopilotChatResponse, CopilotMessage } from "../../copilot/types.js";
import type { CopilotActivityType } from "../../copilot/persistence/index.js";
import { activityTitle } from "./WorkspaceMerger.js";

export class ActivityRecorder {
  public constructor(private readonly kernel: ApiKernel) {}

  public async saveUserMessage(userId: string, message: CopilotMessage): Promise<CopilotMessage> {
    await this.kernel.copilotServices.sessionService.saveMessage(userId, message);
    return message;
  }

  public async persistResponse(userId: string, response: CopilotChatResponse, activityType: CopilotActivityType): Promise<void> {
    await Promise.all([
      this.kernel.copilotServices.sessionService.saveMessage(userId, response.assistantMessage),
      this.kernel.copilotServices.sessionService.completeTurn(userId, response.turnId, response.assistantMessage.id),
      this.kernel.copilotServices.workspaceService.saveWorkspace(userId, response.workspace),
      this.kernel.copilotServices.workspaceService.recordActivity(userId, {
        sessionId: response.sessionId,
        type: activityType,
        title: activityTitle(activityType),
        description: response.assistantMessage.content.slice(0, 180),
        entityType: response.workspace.activePanel === "variants" ? "generation" : "session",
        entityId: response.workspace.productGenerationId ?? response.sessionId,
      }),
    ]);
  }
}
