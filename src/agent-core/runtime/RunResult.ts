import type { PendingAction } from "../confirmation/PendingAction.js";
import type { ToolResult } from "../tools/ToolResult.js";
import type { CriticReview } from "../validation/AgentOutputSchemas.js";
import type { ToolExecutionRecord } from "./CriticGate.js";

export type ExecutedPlan = {
  toolResults: ToolResult[];
  pendingActions: PendingAction[];
  executions: ToolExecutionRecord[];
};

export type LoopRunResult = {
  assistantText: string;
  toolResults: ToolResult[];
  pendingActions: PendingAction[];
  workspacePatch: Record<string, unknown>;
  criticReview?: CriticReview;
};
