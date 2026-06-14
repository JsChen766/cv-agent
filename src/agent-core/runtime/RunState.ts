import type { CopilotWorkspace } from "../../copilot/types.js";
import type { ToolExecutor } from "../tools/ToolExecutor.js";
import type { AgentContext } from "./AgentContext.js";
import type { AgentLoopController } from "./AgentLoopController.js";
import type { AgentMessageBus } from "./AgentMessageBus.js";
import type { AgentRuntimeEmitter } from "./AgentStreamEvent.js";
import type { AgentTraceRecorder } from "./AgentTrace.js";

export type RunState = {
  context: AgentContext;
  trace: AgentTraceRecorder;
  executor: ToolExecutor;
  workspace: CopilotWorkspace | null;
  messageBus: AgentMessageBus;
  loopController: AgentLoopController;
  streamEmitter?: AgentRuntimeEmitter;
  autoRevisionContext?: AutoRevisionContext;
};

export type AutoRevisionContext = {
  autoRevisionAuthorized: true;
  toolName: "generate_resume_from_jd";
  sourcePendingActionId?: string;
};
