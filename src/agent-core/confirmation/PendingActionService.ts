import { randomUUID } from "node:crypto";
import type { AgentContext } from "../runtime/AgentContext.js";
import { AgentError } from "../runtime/AgentError.js";
import type { ToolDefinition } from "../tools/Tool.js";
import type { ToolExecutor } from "../tools/ToolExecutor.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolResult } from "../tools/ToolResult.js";
import type { PendingAction } from "./PendingAction.js";

export type CreatePendingActionInput = {
  userId: string;
  sessionId: string;
  turnId?: string;
  tool: ToolDefinition;
  toolArguments: Record<string, unknown>;
  title?: string;
  summary?: string;
  affectedResources?: PendingAction["affectedResources"];
  preview?: PendingAction["preview"];
};

export class PendingActionService {
  private readonly actions = new Map<string, PendingAction>();

  public create(input: CreatePendingActionInput): PendingAction {
    const now = new Date();
    const pending: PendingAction = {
      id: `pa-${randomUUID()}`,
      userId: input.userId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      toolName: input.tool.name,
      toolArguments: input.toolArguments,
      status: "pending",
      title: input.title ?? titleForTool(input.tool.name),
      summary: input.summary ?? input.tool.description,
      riskLevel: input.tool.riskLevel,
      affectedResources: input.affectedResources ?? [],
      preview: input.preview,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
    };
    this.actions.set(pending.id, pending);
    return pending;
  }

  public list(userId: string, sessionId?: string): PendingAction[] {
    return Array.from(this.actions.values()).filter((action) => (
      action.userId === userId &&
      (!sessionId || action.sessionId === sessionId) &&
      action.status === "pending" &&
      !isExpired(action)
    ));
  }

  public get(userId: string, id: string): PendingAction | undefined {
    const action = this.actions.get(id);
    if (!action || action.userId !== userId) return undefined;
    if (isExpired(action) && action.status === "pending") {
      action.status = "expired";
    }
    return action;
  }

  public cancel(userId: string, id: string): PendingAction {
    const action = this.get(userId, id);
    if (!action) throw new AgentError("PERMISSION_DENIED", "Pending action not found.", { statusCode: 404 });
    if (action.status !== "pending") throw new AgentError("CONFIRMATION_EXPIRED", "Pending action is not pending.", { statusCode: 409 });
    action.status = "cancelled";
    return action;
  }

  public async confirm(input: {
    userId: string;
    id: string;
    registry: ToolRegistry;
    executor: ToolExecutor;
    context: AgentContext;
  }): Promise<{ action: PendingAction; result: ToolResult }> {
    const action = this.get(input.userId, input.id);
    if (!action) throw new AgentError("PERMISSION_DENIED", "Pending action not found.", { statusCode: 404 });
    if (action.status !== "pending") throw new AgentError("CONFIRMATION_EXPIRED", "Pending action is not pending.", { statusCode: 409 });
    if (isExpired(action)) {
      action.status = "expired";
      throw new AgentError("CONFIRMATION_EXPIRED", "Pending action expired.", { statusCode: 409 });
    }
    const tool = input.registry.get(action.toolName);
    if (!tool) throw new AgentError("TOOL_NOT_FOUND", "Pending action tool no longer exists.", { statusCode: 404 });
    const parsed = tool.inputSchema.safeParse(action.toolArguments);
    if (!parsed.success) throw new AgentError("TOOL_VALIDATION_FAILED", "Pending action input is invalid.", { statusCode: 400 });

    action.status = "confirmed";
    try {
      const result = await input.executor.executeDefinition(tool, parsed.data as Record<string, unknown>, input.context);
      action.status = result.status === "success" ? "executed" : "failed";
      return { action, result };
    } catch (error) {
      action.status = "failed";
      throw error;
    }
  }
}

function isExpired(action: PendingAction): boolean {
  return Date.parse(action.expiresAt) <= Date.now();
}

function titleForTool(toolName: string): string {
  return toolName.replace(/_/g, " ");
}
