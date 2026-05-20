import type { ApiKernel } from "../api/types.js";
import type { KernelRequestContext } from "../kernel/context.js";
import type {
  CopilotActionRequest,
  CopilotChatRequest,
  CopilotStreamEvent,
} from "./types.js";
import { AgentOrchestrator } from "../agent-core/runtime/AgentOrchestrator.js";

export type CopilotOrchestratorDeps = {
  kernel: ApiKernel;
};

/**
 * Compatibility facade for existing routes/tests.
 * Copilot is the product API surface; AgentRuntime is the execution boundary.
 */
export class CopilotOrchestrator {
  private readonly runtime: AgentOrchestrator;

  public constructor(deps: CopilotOrchestratorDeps) {
    this.runtime = new AgentOrchestrator({ kernel: deps.kernel });
  }

  public get pendingActions() {
    return this.runtime.pendingActions;
  }

  public getSession(userId: string, id: string) {
    return this.runtime.getSession(userId, id);
  }

  public handleChat(ctx: KernelRequestContext, body: CopilotChatRequest) {
    return this.runtime.handleChat(ctx, body);
  }

  public handleAction(ctx: KernelRequestContext, body: CopilotActionRequest) {
    return this.runtime.handleExplicitAction(ctx, body);
  }

  public runtimeConfirm(ctx: KernelRequestContext, pendingActionId: string) {
    return this.runtime.confirmPendingAction(ctx, pendingActionId);
  }

  public handleStream(
    ctx: KernelRequestContext,
    body: CopilotChatRequest,
    emit: (event: CopilotStreamEvent["type"], data: unknown) => void,
  ) {
    return this.runtime.handleChat(ctx, body)
      .then((response) => {
        emit("copilot.turn.started", { type: "copilot.turn.started", sessionId: response.sessionId, turnId: response.turnId });
        emit("copilot.message.created", response.assistantMessage);
        emit("copilot.workspace.updated", {
          type: "copilot.workspace.updated",
          sessionId: response.sessionId,
          status: response.workspace.status,
          variantCount: response.workspace.variants.length,
        });
        emit("copilot.action.required", { type: "copilot.action.required", actions: response.nextActions });
        emit("copilot.completed", {
          type: "copilot.completed",
          sessionId: response.sessionId,
          turnId: response.turnId,
          workspaceStatus: response.workspace.status,
        });
      })
      .catch((error) => {
        emit("copilot.failed", {
          type: "copilot.failed",
          sessionId: body.sessionId ?? "",
          turnId: "",
          message: error instanceof Error ? error.message : "Copilot failed",
        });
      });
  }
}
