import { randomUUID } from "node:crypto";
import type { CopilotChatRequest, CopilotChatResponse, CopilotStreamEvent } from "../../copilot/types.js";

export class StreamEmitter {
  public emitResponse(
    response: CopilotChatResponse,
    emit: (event: CopilotStreamEvent["type"], data: unknown) => void,
  ): void {
    emit("copilot.turn.started", { type: "copilot.turn.started", sessionId: response.sessionId, turnId: response.turnId });
    emit("copilot.message.created", { type: "copilot.message.created", message: response.assistantMessage });
    for (const item of response.timeline) emit("copilot.timeline.updated", { type: "copilot.timeline.updated", item });
    emit("copilot.workspace.updated", {
      type: "copilot.workspace.updated",
      sessionId: response.sessionId,
      status: response.workspace.status,
      variantCount: response.workspace.variants.length,
    });
    if (response.nextActions.length > 0) emit("copilot.action.required", { type: "copilot.action.required", actions: response.nextActions });
    emit("copilot.completed", { type: "copilot.completed", sessionId: response.sessionId, turnId: response.turnId, workspaceStatus: response.workspace.status });
  }

  public emitFailure(
    request: CopilotChatRequest,
    error: unknown,
    emit: (event: CopilotStreamEvent["type"], data: unknown) => void,
  ): void {
    emit("copilot.failed", {
      type: "copilot.failed",
      sessionId: request.sessionId ?? "unknown",
      turnId: `ct-${randomUUID()}`,
      message: error instanceof Error ? error.message : "Copilot stream failed.",
    });
  }
}
