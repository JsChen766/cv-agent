import { randomUUID } from "node:crypto";
import type { AgentContext } from "../runtime/AgentContext.js";
import { AgentError } from "../runtime/AgentError.js";
import type { CopilotWorkspace } from "../../copilot/types.js";
import { guardToolIds, stripInternalToolArgs } from "../security/ToolIdGuard.js";
import { guardToolScope } from "../security/ToolScopeGuard.js";
import type { ToolDefinition } from "../tools/Tool.js";
import type { ToolExecutor } from "../tools/ToolExecutor.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolResult } from "../tools/ToolResult.js";
import type { PendingAction } from "./PendingAction.js";
import { InMemoryPendingActionRepository } from "./InMemoryPendingActionRepository.js";
import type { PendingActionRepository } from "./PendingActionRepository.js";

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
  public constructor(private readonly repository: PendingActionRepository = new InMemoryPendingActionRepository()) {}

  public async create(input: CreatePendingActionInput): Promise<PendingAction> {
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
    return this.repository.create(pending);
  }

  public async list(userId: string, sessionId?: string): Promise<PendingAction[]> {
    const actions = await this.repository.list(userId, sessionId);
    const active: PendingAction[] = [];
    for (const action of actions) {
      if (action.status === "pending" && isExpired(action)) {
        await this.repository.update({ ...action, status: "expired" });
        continue;
      }
      if (action.status === "pending") active.push(action);
    }
    return active;
  }

  public async get(userId: string, id: string): Promise<PendingAction | undefined> {
    const action = await this.repository.getById(userId, id);
    if (!action) return undefined;
    if (isExpired(action) && action.status === "pending") {
      return this.repository.update({ ...action, status: "expired" });
    }
    return action;
  }

  public async cancel(userId: string, id: string): Promise<PendingAction> {
    const action = await this.get(userId, id);
    if (!action) throw new AgentError("PERMISSION_DENIED", "Pending action not found.", { statusCode: 404 });
    if (action.status !== "pending") throw new AgentError("CONFIRMATION_EXPIRED", "Pending action is not pending.", { statusCode: 409 });
    return this.repository.update({ ...action, status: "cancelled" });
  }

  public async confirm(input: {
    userId: string;
    id: string;
    registry: ToolRegistry;
    executor: ToolExecutor;
    context: AgentContext;
    workspace?: CopilotWorkspace | null;
  }): Promise<{ action: PendingAction; result: ToolResult }> {
    const action = await this.get(input.userId, input.id);
    if (!action) throw new AgentError("PERMISSION_DENIED", "Pending action not found.", { statusCode: 404 });
    if (action.status !== "pending") throw new AgentError("CONFIRMATION_EXPIRED", "Pending action is not pending.", { statusCode: 409 });
    if (isExpired(action)) {
      await this.repository.update({ ...action, status: "expired" });
      throw new AgentError("CONFIRMATION_EXPIRED", "Pending action expired.", { statusCode: 409 });
    }
    const tool = input.registry.get(action.toolName);
    if (!tool) throw new AgentError("TOOL_NOT_FOUND", "Pending action tool no longer exists.", { statusCode: 404 });
    const idGuardResult = guardToolIds(action.toolName, action.toolArguments);
    if (idGuardResult) {
      const updated = await this.repository.update({ ...action, status: "failed" });
      return { action: updated, result: confirmBlockedResult(action.toolName, "confirm_guard_blocked", idGuardResult.message) };
    }
    const parsed = tool.inputSchema.safeParse(stripInternalToolArgs(action.toolArguments));
    if (!parsed.success) {
      const updated = await this.repository.update({ ...action, status: "failed" });
      return { action: updated, result: confirmBlockedResult(action.toolName, "confirm_schema_blocked", "Pending action input is invalid. Please start the action again.") };
    }
    const scopeGuardResult = await guardToolScope(action.toolName, parsed.data as Record<string, unknown>, input.context, input.workspace ?? input.context.workspace ?? null);
    if (scopeGuardResult) {
      const updated = await this.repository.update({ ...action, status: "failed" });
      return { action: updated, result: confirmBlockedResult(action.toolName, "confirm_guard_blocked", scopeGuardResult.message) };
    }

    await this.repository.update({ ...action, status: "confirmed" });
    try {
      const result = await input.executor.executeDefinition(tool, parsed.data as Record<string, unknown>, input.context);
      const updated = await this.repository.update({ ...action, status: result.status === "success" ? "executed" : "failed" });
      return { action: updated, result };
    } catch (error) {
      await this.repository.update({ ...action, status: "failed" });
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

function confirmBlockedResult(toolName: string, reason: string, message = "This pending action is no longer valid. Please start it again."): ToolResult {
  return {
    status: "needs_input",
    message,
    visibility: "error_user_visible",
    actionResult: {
      actionType: toolName,
      status: "needs_input",
      reason,
      message,
    },
  };
}
