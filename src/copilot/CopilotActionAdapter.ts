import type { KernelRequestContext } from "../kernel/context.js";
import type { CopilotActionRequest } from "./types.js";
import type { AgentRuntime } from "../agents/runtime/AgentRuntime.js";

export class CopilotActionAdapter {
  public constructor(private readonly runtime: AgentRuntime) {}

  public handleAction(ctx: KernelRequestContext, body: CopilotActionRequest) {
    return this.runtime.handleAction(ctx, body);
  }
}
