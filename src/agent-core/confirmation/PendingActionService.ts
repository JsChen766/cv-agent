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
    const actions = await this.listAll(userId, sessionId);
    return actions.filter((action) => action.status === "pending");
  }

  public async listAll(userId: string, sessionId?: string): Promise<PendingAction[]> {
    const actions = await this.repository.list(userId, sessionId);
    const normalized: PendingAction[] = [];
    for (const action of actions) {
      if (action.status === "pending" && isExpired(action)) {
        const expired = await this.repository.update({ ...action, status: "expired" });
        normalized.push(expired);
        continue;
      }
      normalized.push(action);
    }
    return normalized;
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
    if (!action) throw new AgentError("PERMISSION_DENIED", "该操作不存在或已被清理。", { statusCode: 404 });
    if (action.status === "cancelled") return action;
    if (action.status !== "pending") {
      throw new AgentError("CONFIRMATION_EXPIRED", "该操作已处理，无法重复取消。", { statusCode: 409 });
    }
    return this.repository.update({ ...action, status: "cancelled" });
  }

  public async markExecuted(userId: string, id: string, result: ToolResult): Promise<PendingAction | undefined> {
    const action = await this.get(userId, id);
    if (!action) return undefined;
    return this.repository.update({ ...action, status: "executed", lastResult: result });
  }

  public async markFailed(userId: string, id: string, result: ToolResult): Promise<PendingAction | undefined> {
    const action = await this.get(userId, id);
    if (!action) return undefined;
    return this.repository.update({ ...action, status: "failed", lastResult: result });
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
    if (!action) throw new AgentError("PERMISSION_DENIED", "该操作不存在或已被清理。", { statusCode: 404 });
    if ((action.status === "executed" || action.status === "confirmed") && action.lastResult) {
      return {
        action,
        result: {
          ...action.lastResult,
          message: action.lastResult.message || "该操作已确认，无需重复提交。",
        },
      };
    }
    if (action.status !== "pending") {
      if (action.status === "confirmed" || action.status === "executed") {
        return { action, result: nonPendingResult(action) };
      }
      throw new AgentError("CONFIRMATION_EXPIRED", nonPendingResult(action).message || "该操作已失效，请重新发起。", { statusCode: 409 });
    }
    if (isExpired(action)) {
      await this.repository.update({ ...action, status: "expired" });
      throw new AgentError("CONFIRMATION_EXPIRED", "该操作已失效，请重新发起。", { statusCode: 409 });
    }
    const tool = input.registry.get(action.toolName);
    if (!tool) {
      const failed = await this.repository.update({ ...action, status: "failed" });
      return {
        action: failed,
        result: {
          status: "needs_input",
          message: "该操作对应的执行器已不可用，请重新发起。",
          visibility: "error_user_visible",
          actionResult: {
            actionType: action.toolName,
            status: "needs_input",
            reason: "tool_not_found",
            message: "该操作对应的执行器已不可用，请重新发起。",
          },
        },
      };
    }
    const idGuardResult = guardToolIds(action.toolName, action.toolArguments);
    if (idGuardResult) {
      const updated = await this.repository.update({ ...action, status: "failed", lastResult: idGuardResult });
      return { action: updated, result: confirmBlockedResult(action.toolName, "confirm_guard_blocked", idGuardResult.message) };
    }
    const parsed = tool.inputSchema.safeParse(stripInternalToolArgs(action.toolArguments));
    if (!parsed.success) {
      const blocked = confirmBlockedResult(action.toolName, "confirm_schema_blocked", "Pending action input is invalid. Please start the action again.");
      const updated = await this.repository.update({ ...action, status: "failed", lastResult: blocked });
      return { action: updated, result: blocked };
    }
    const scopeGuardResult = await guardToolScope(action.toolName, parsed.data as Record<string, unknown>, input.context, input.workspace ?? input.context.workspace ?? null);
    if (scopeGuardResult) {
      const updated = await this.repository.update({ ...action, status: "failed", lastResult: scopeGuardResult });
      return { action: updated, result: confirmBlockedResult(action.toolName, "confirm_guard_blocked", scopeGuardResult.message) };
    }

    const claimed = await this.repository.updateStatusIfCurrent(input.userId, action.id, "pending", { status: "confirmed" });
    if (!claimed) {
      const latest = await this.get(input.userId, input.id);
      if (!latest) throw new AgentError("PERMISSION_DENIED", "该操作不存在或已被清理。", { statusCode: 404 });
      if ((latest.status === "executed" || latest.status === "confirmed") && latest.lastResult) {
        return {
          action: latest,
          result: {
            ...latest.lastResult,
            message: latest.lastResult.message || "该操作已确认，无需重复提交。",
          },
        };
      }
      return { action: latest, result: nonPendingResult(latest) };
    }
    try {
      if (claimed.toolName === "generate_resume_from_jd") {
        const job = await input.context.kernel.platformServices.backgroundJobs.createJob({
          userId: input.context.userId,
          type: "long_generation",
          input: {
            actionType: "generate_resume_from_jd",
            pendingActionId: claimed.id,
            sessionId: input.context.sessionId,
            toolArguments: parsed.data as Record<string, unknown>,
          },
          maxAttempts: 1,
        });
        const result: ToolResult = {
          status: "success",
          message: "已开始生成简历版本，生成完成后会更新结果。",
          data: {
            jobId: job.id,
            jobStatus: job.status,
            actionType: claimed.toolName,
          },
          workspacePatch: {
            activePanel: "variants",
            status: "generating",
            summary: "正在生成 JD 简历版本…",
          },
          actionResult: {
              actionType: claimed.toolName,
              status: "success",
            metadata: {
              jobId: job.id,
              jobStatus: job.status,
              generating: true,
            },
          },
          visibility: "user_summary",
        };
        const updated = await this.repository.update({
          ...claimed,
          status: "confirmed",
          lastResult: result,
        });
        return { action: updated, result };
      }
      const result = await input.executor.executeDefinition(tool, parsed.data as Record<string, unknown>, input.context);
      const updated = await this.repository.update({
        ...claimed,
        status: result.status === "success" ? "executed" : "failed",
        lastResult: result,
      });
      return { action: updated, result };
    } catch (error) {
      await this.repository.update({ ...claimed, status: "failed" });
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

function confirmBlockedResult(toolName: string, reason: string, message = "该操作已失效，请重新发起。"): ToolResult {
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

function nonPendingResult(action: PendingAction): ToolResult {
  const message = action.status === "executed" || action.status === "confirmed"
    ? "该操作已确认，无需重复提交。"
    : action.status === "expired" || action.status === "cancelled"
      ? "该操作已失效，请重新发起。"
      : "该操作当前不可执行，请重新发起。";
  return {
    ...(action.lastResult || {}),
    status: "needs_input",
    message,
    visibility: "error_user_visible",
    actionResult: {
      actionType: action.toolName,
      status: "needs_input",
      reason: "pending_action_not_pending",
      message,
    },
  };
}
