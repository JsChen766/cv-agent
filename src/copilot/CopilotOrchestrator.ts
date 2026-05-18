import type { ApiKernel } from "../api/types.js";
import type { KernelRequestContext } from "../kernel/context.js";
import type {
  CopilotActionRequest,
  CopilotChatRequest,
  CopilotStreamEvent,
} from "./types.js";
import { AgentRuntime } from "../agents/runtime/AgentRuntime.js";
import { CopilotApiAdapter } from "./CopilotApiAdapter.js";
import { CopilotActionAdapter } from "./CopilotActionAdapter.js";

export type CopilotOrchestratorDeps = {
  kernel: ApiKernel;
};

/**
 * Compatibility facade for existing routes/tests.
 * Copilot is the product API surface; AgentRuntime is the execution boundary.
 */
export class CopilotOrchestrator {
  private readonly runtime: AgentRuntime;
  private readonly chatAdapter: CopilotApiAdapter;
  private readonly actionAdapter: CopilotActionAdapter;

  public constructor(deps: CopilotOrchestratorDeps) {
    this.runtime = new AgentRuntime({ kernel: deps.kernel });
    this.chatAdapter = new CopilotApiAdapter(this.runtime);
    this.actionAdapter = new CopilotActionAdapter(this.runtime);
  }

  public getSession(userId: string, id: string) {
    return this.runtime.getSession(userId, id);
  }

  public handleChat(ctx: KernelRequestContext, body: CopilotChatRequest) {
    return this.chatAdapter.handleChat(ctx, body);
  }

  public handleAction(ctx: KernelRequestContext, body: CopilotActionRequest) {
    return this.actionAdapter.handleAction(ctx, body);
  }

  public handleStream(
    ctx: KernelRequestContext,
    body: CopilotChatRequest,
    emit: (event: CopilotStreamEvent["type"], data: unknown) => void,
  ) {
    return this.chatAdapter.handleStream(ctx, body, emit);
  }
}
