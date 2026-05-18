import type { CopilotChatRequest, CopilotSession, CopilotWorkspace } from "../../copilot/types.js";
import type { KernelRequestContext } from "../../kernel/context.js";
import { safeClarificationDecision, type AgentDecision } from "../schema/AgentDecision.js";
import { AgentToolRegistry, type AgentToolResult } from "../tools/AgentToolRegistry.js";
import { AgentQuotaGuard } from "./AgentQuotaGuard.js";
import { AgentRunLogger } from "./AgentRunLogger.js";
import { ResumeIngestionCoordinator } from "./ResumeIngestionCoordinator.js";

export type ToolExecutionContextInput = {
  ctx: KernelRequestContext;
  session: CopilotSession;
  workspace: CopilotWorkspace | null;
  request: CopilotChatRequest;
  turnId: string;
};

export class ToolExecutionService {
  public constructor(
    private readonly tools: AgentToolRegistry,
    private readonly quota: AgentQuotaGuard,
    private readonly runLogger: AgentRunLogger,
    private readonly resumeIngestion: ResumeIngestionCoordinator,
  ) {}

  public sanitizeDecision(
    decision: AgentDecision,
    input: { requestId: string; sessionId: string },
  ): AgentDecision {
    const calls = normalizeToolCalls(decision);
    if (!this.toolCallsAreValid(calls, input) || this.quota.isOverMaxToolCalls(calls.length)) {
      return safeClarificationDecision();
    }
    return decision;
  }

  public async executeDecisionTools(
    context: ToolExecutionContextInput,
    decision: AgentDecision,
    ingestionWarnings: string[],
    agentRunId: string,
  ): Promise<AgentToolResult[]> {
    const calls = normalizeToolCalls(decision);
    const results: AgentToolResult[] = [];
    for (const call of calls) {
      await this.quota.consumeToolCall(context.ctx.user.id);
      if (call.toolName === "generate_resume_variants") {
        await this.quota.consumeGeneration(context.ctx.user.id);
        await this.resumeIngestion.ingestResumeIfNeeded(context.ctx, context.session, ingestionWarnings);
      }
      results.push(await this.executeToolWithLog(call.toolName, call.arguments, context, agentRunId));
    }
    return results;
  }

  public async executeToolWithLog(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolExecutionContextInput,
    agentRunId: string,
  ): Promise<AgentToolResult> {
    const startedAt = Date.now();
    const toolRun = await this.runLogger.createToolRun({
      agentRunId,
      ctx: context.ctx,
      sessionId: context.session.id,
      toolName,
      args,
    });
    try {
      const result = await this.tools.execute(toolName, args, context);
      await this.runLogger.completeToolRun(toolRun.id, result, startedAt);
      return result;
    } catch (error) {
      await this.runLogger.failToolRun(toolRun.id, error, startedAt);
      throw error;
    }
  }

  private toolCallsAreValid(
    calls: Array<{ toolName: string; arguments: Record<string, unknown> }>,
    input: { requestId: string; sessionId: string },
  ): boolean {
    const unknownTools = [...new Set(calls.map((call) => call.toolName).filter((name) => !this.tools.hasTool(name)))];
    if (unknownTools.length === 0) return true;
    console.warn("[AgentRuntime] unknown tool call", {
      event: "agent_unknown_tool_call",
      requestId: input.requestId,
      sessionId: input.sessionId,
      unknownTools,
      allowedToolCount: this.tools.getToolSchemas().length,
    });
    return false;
  }
}

export function normalizeToolCalls(decision: AgentDecision): Array<{ toolName: string; arguments: Record<string, unknown> }> {
  if (decision.toolCalls?.length) return decision.toolCalls;
  if (decision.mode === "generate") return [{ toolName: "generate_resume_variants", arguments: {} }];
  if (decision.mode === "revise") return [{ toolName: "revise_variant", arguments: {} }];
  if (decision.mode === "explain_workspace") return [{ toolName: "explain_choice", arguments: {} }];
  return [];
}
