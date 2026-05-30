import type { ApiKernel } from "../api/types.js";
import type { KernelRequestContext } from "../api/context.js";
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

  public cancelPendingAction(userId: string, id: string) {
    return this.runtime.cancelPendingAction(userId, id);
  }

  public handleStream(
    ctx: KernelRequestContext,
    body: CopilotChatRequest,
    emit: (event: CopilotStreamEvent["type"], data: unknown) => void,
  ) {
    return this.runtime.handleChatStream(ctx, body, (event) => emit(event.type, event))
      .catch((error) => {
        emit("agent.failed", {
          type: "agent.failed",
          sessionId: body.sessionId ?? "",
          turnId: "",
          createdAt: new Date().toISOString(),
          label: "处理失败",
          status: "failed",
          message: error instanceof Error ? error.message : "Copilot failed",
          payload: { message: error instanceof Error ? error.message : "Copilot failed" },
        });
      });
  }
}
