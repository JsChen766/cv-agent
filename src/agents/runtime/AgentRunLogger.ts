import { randomUUID } from "node:crypto";
import type { ApiKernel } from "../../api/types.js";
import { mapError } from "../../api/errors.js";
import type { KernelRequestContext } from "../../kernel/context.js";
import type { AgentRun, AgentToolRun } from "../../platform/index.js";
import type { AgentToolResult } from "../tools/AgentToolRegistry.js";

export class AgentRunLogger {
  public constructor(private readonly kernel: ApiKernel) {}

  public async createRun(input: {
    ctx: KernelRequestContext;
    sessionId: string;
    mode: string;
    model?: string;
  }): Promise<AgentRun> {
    return this.kernel.platformServices.agentRuns.createRun({
      id: `run-${randomUUID()}`,
      userId: input.ctx.user.id,
      sessionId: input.sessionId,
      requestId: input.ctx.request.requestId,
      mode: input.mode,
      model: input.model,
    });
  }

  public async completeRun(runId: string, input: { turnId?: string; decisionMode?: string; startedAt: number }): Promise<void> {
    await this.kernel.platformServices.agentRuns.completeRun(runId, {
      turnId: input.turnId,
      decisionMode: input.decisionMode,
      latencyMs: Date.now() - input.startedAt,
    });
  }

  public async failRun(runId: string, error: unknown, startedAt: number): Promise<void> {
    const mapped = mapError(error);
    await this.kernel.platformServices.agentRuns.failRun(runId, {
      errorCode: mapped.code,
      errorMessage: mapped.message,
      latencyMs: Date.now() - startedAt,
    });
  }

  public async createToolRun(input: {
    agentRunId: string;
    ctx: KernelRequestContext;
    sessionId: string;
    toolName: string;
    args: Record<string, unknown>;
  }): Promise<AgentToolRun> {
    return this.kernel.platformServices.agentRuns.createToolRun({
      id: `toolrun-${randomUUID()}`,
      agentRunId: input.agentRunId,
      userId: input.ctx.user.id,
      sessionId: input.sessionId,
      toolName: input.toolName,
      inputSummary: summarizeToolInput(input.args),
    });
  }

  public async completeToolRun(toolRunId: string, result: AgentToolResult, startedAt: number): Promise<void> {
    await this.kernel.platformServices.agentRuns.completeToolRun(toolRunId, {
      status: result.status === "success" ? "completed" : result.status,
      latencyMs: Date.now() - startedAt,
      outputSummary: summarizeToolOutput(result),
    });
  }

  public async failToolRun(toolRunId: string, error: unknown, startedAt: number): Promise<void> {
    const mapped = mapError(error);
    await this.kernel.platformServices.agentRuns.completeToolRun(toolRunId, {
      status: "failed",
      latencyMs: Date.now() - startedAt,
      errorCode: mapped.code,
      errorMessage: mapped.message,
    });
  }
}

function summarizeToolInput(args: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (/text|content|raw|resume|jd/i.test(key) && typeof value === "string") {
      summary[key] = { type: "string", length: value.length };
    } else if (Array.isArray(value)) {
      summary[key] = { type: "array", length: value.length };
    } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      summary[key] = value;
    } else if (value && typeof value === "object") {
      summary[key] = { type: "object" };
    }
  }
  return summary;
}

function summarizeToolOutput(result: AgentToolResult): Record<string, unknown> {
  return {
    status: result.status,
    hasWorkspacePatch: Boolean(result.workspacePatch),
    timelineItemCount: result.timelineItems?.length ?? 0,
    nextActionCount: result.nextActions?.length ?? 0,
    suggestedPromptCount: result.suggestedPrompts?.length ?? 0,
  };
}
