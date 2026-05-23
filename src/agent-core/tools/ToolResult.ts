import type { ToolResultVisibility } from "../../copilot/response/ToolResultVisibility.js";

export type ToolResultStatus = "success" | "needs_input" | "failed";

export type ToolResult = {
  status: ToolResultStatus;
  message?: string;
  data?: unknown;
  workspacePatch?: Record<string, unknown>;
  actionResult?: Record<string, unknown>;
  pendingActionId?: string;
  visibility?: ToolResultVisibility;
};
