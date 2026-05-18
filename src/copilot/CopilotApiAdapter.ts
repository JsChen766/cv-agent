import type { KernelRequestContext } from "../kernel/context.js";
import type { CopilotChatRequest, CopilotStreamEvent } from "./types.js";
import type { AgentRuntime } from "../agents/runtime/AgentRuntime.js";

export class CopilotApiAdapter {
  public constructor(private readonly runtime: AgentRuntime) {}

  public handleChat(ctx: KernelRequestContext, body: CopilotChatRequest) {
    return this.runtime.handleChat(ctx, body);
  }

  public handleStream(
    ctx: KernelRequestContext,
    body: CopilotChatRequest,
    emit: (event: CopilotStreamEvent["type"], data: unknown) => void,
  ) {
    return this.runtime.handleStream(ctx, body, emit);
  }
}
