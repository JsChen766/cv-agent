import type { ApiKernel } from "../../api/types.js";
import type { ActiveAssetContext } from "../../copilot/ActiveAssetContextBuilder.js";
import type { CopilotClientState, CopilotMessage, CopilotWorkspace } from "../../copilot/types.js";
import type { KernelRequestContext } from "../../api/context.js";
import type { ToolDefinition } from "../tools/Tool.js";
import type { AgentMessage } from "./AgentMessage.js";
import type { AgentLoopState, AgentObservation } from "./AgentObservation.js";
import type { AgentTrace } from "./AgentTrace.js";

export type AgentContext = {
  kernel: ApiKernel;
  requestContext: KernelRequestContext;
  userId: string;
  sessionId: string;
  turnId: string;
  userMessage: string;
  recentMessages: CopilotMessage[];
  workspace: CopilotWorkspace | null;
  clientState?: CopilotClientState;
  activeAssetContext?: ActiveAssetContext;
  productContext: Record<string, unknown>;
  availableTools: ToolDefinition[];
  trace: AgentTrace;
  observations?: AgentObservation[];
  agentMessages?: AgentMessage[];
  loopState?: AgentLoopState;
};
