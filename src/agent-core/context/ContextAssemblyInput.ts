import type { ApiKernel } from "../../api/types.js";
import type { KernelRequestContext } from "../../api/context.js";
import type { CopilotChatRequest } from "../../copilot/types.js";
import type { AgentRuntimeEmitter } from "../runtime/AgentStreamEvent.js";
import type { AgentCapabilityRegistry } from "../capabilities/AgentCapabilityRegistry.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";

export type ContextAssemblyInput = {
  ctx: KernelRequestContext;
  sessionId: string;
  turnId: string;
  userMessage: string;
  request: CopilotChatRequest;
  productContext: Record<string, unknown>;
  streamEmitter?: AgentRuntimeEmitter;
};

export type ContextAssemblyPipelineDeps = {
  kernel: ApiKernel;
  tools: ToolRegistry;
  capabilityRegistry: AgentCapabilityRegistry;
};
