import type { ToolRiskLevel } from "../tools/ToolPermissions.js";
import type { ToolResult } from "../tools/ToolResult.js";

export type PendingActionStatus = "pending" | "confirmed" | "cancelled" | "executed" | "expired" | "failed";

export type PendingAction = {
  id: string;
  userId: string;
  sessionId: string;
  turnId?: string;
  toolName: string;
  toolArguments: Record<string, unknown>;
  status: PendingActionStatus;
  title: string;
  summary: string;
  riskLevel: ToolRiskLevel;
  affectedResources: Array<{
    type: "experience" | "jd" | "resume" | "export";
    id?: string;
    title?: string;
  }>;
  preview?: {
    before?: unknown;
    after?: unknown;
  };
  lastResult?: ToolResult;
  createdAt: string;
  expiresAt: string;
};
