import { randomUUID } from "node:crypto";
import type { ApiKernel } from "../../api/types.js";
import type { KernelRequestContext } from "../../kernel/context.js";
import type {
  CopilotActionRequest,
  CopilotChatRequest,
  CopilotChatResponse,
  CopilotMessage,
  CopilotSession,
  CopilotStreamEvent,
  CopilotWorkspace,
  ProductAction,
} from "../../copilot/types.js";
import type { CopilotActivityType } from "../../copilot/persistence/index.js";
import { CopilotPresenter } from "../../copilot/CopilotPresenter.js";
import { AgentToolRegistry, type AgentToolResult } from "../tools/AgentToolRegistry.js";
import { FrontDeskAgent } from "../frontdesk/FrontDeskAgent.js";
import { readAgentRuntimeConfig, type AgentRuntimeConfig } from "./AgentRuntimeConfig.js";
import { safeClarificationDecision, type AgentDecision } from "../schema/AgentDecision.js";
import { ApiError, ErrorCodes, mapError } from "../../api/errors.js";
import { readPlatformConfig } from "../../platform/index.js";

export type AgentRuntimeDeps = {
  kernel: ApiKernel;
  config?: AgentRuntimeConfig;
};

export class AgentRuntime {
  private readonly config: AgentRuntimeConfig;
  private readonly tools: AgentToolRegistry;
  private readonly frontDesk: FrontDeskAgent;
  private readonly presenter = new CopilotPresenter();

  public constructor(private readonly deps: AgentRuntimeDeps) {
    this.config = deps.config ?? readAgentRuntimeConfig();
    this.tools = new AgentToolRegistry(deps.kernel);
    if (!deps.kernel.frontDeskModelClient) {
      throw new Error("frontDeskModelClient is required for AgentRuntime.");
    }
    this.frontDesk = new FrontDeskAgent({ modelClient: deps.kernel.frontDeskModelClient });
  }

  public async getSession(userId: string, sessionId: string): Promise<CopilotSession | undefined> {
    return (await this.deps.kernel.copilotServices.sessionService.getSession(userId, sessionId)) ?? undefined;
  }

  public async handleChat(
    ctx: KernelRequestContext,
    request: CopilotChatRequest,
  ): Promise<CopilotChatResponse & { ingestionWarnings: string[] }> {
    const ingestionWarnings: string[] = [];
    this.assertPromptWithinLimit(request);
    await this.deps.kernel.platformServices.usage.consume({ userId: ctx.user.id, metric: "message" });
    const session = await this.deps.kernel.copilotServices.sessionService.getOrCreateSession(ctx.user.id, {
      sessionId: request.sessionId,
      resumeText: request.resumeText,
      jdText: request.jdText,
      targetRole: request.targetRole,
    });
    await this.acquireSessionLock(ctx, session.id);
    const run = await this.deps.kernel.platformServices.agentRuns.createRun({
      id: `run-${randomUUID()}`,
      userId: ctx.user.id,
      sessionId: session.id,
      requestId: ctx.request.requestId,
      mode: this.config.frontDeskAgentMode,
      model: this.config.model,
    });
    const startedAt = Date.now();
    try {
      const userMessage = await this.saveMessage(ctx.user.id, {
        id: `msg-${randomUUID()}`,
        sessionId: session.id,
        role: "user",
        content: request.message,
        kind: "plain_text",
        createdAt: new Date().toISOString(),
      });
      const turn = await this.deps.kernel.copilotServices.sessionService.createTurn(ctx.user.id, session.id, userMessage.id);
      const [workspace, recentMessages] = await Promise.all([
        this.deps.kernel.copilotServices.workspaceService.getWorkspace(ctx.user.id, session.id),
        this.deps.kernel.copilotServices.sessionService.getRecentMessages(ctx.user.id, session.id, 6),
      ]);

      let decision = await this.frontDesk.decide(this.decisionInput(ctx, request, session, workspace, recentMessages));

      if (!this.decisionToolCallsAreValid(decision, {
        requestId: ctx.request.requestId,
        sessionId: session.id,
      }) || normalizeToolCalls(decision).length > readPlatformConfig().maxToolCallsPerRun) {
        decision = safeClarificationDecision();
      }

      const toolResults = await this.executeDecisionTools(ctx, request, session, workspace, turn.id, decision, ingestionWarnings, run.id);
      const nextWorkspace = mergeWorkspace(session.id, workspace, decision, toolResults);
      const response = this.presenter.present({
        sessionId: session.id,
        turnId: turn.id,
        decision,
        toolResults,
        workspace: nextWorkspace,
      });
      response.assistantMessage.content = await this.synthesizeFinalAnswer(decision, toolResults, response);

      await this.persistResponse(ctx.user.id, response, activityTypeForDecision(decision, toolResults));
      await this.deps.kernel.platformServices.agentRuns.completeRun(run.id, {
        turnId: turn.id,
        decisionMode: decision.mode,
        latencyMs: Date.now() - startedAt,
      });
      return { ...response, ingestionWarnings };
    } catch (error) {
      const mapped = mapError(error);
      await this.deps.kernel.platformServices.agentRuns.failRun(run.id, {
        errorCode: mapped.code,
        errorMessage: mapped.message,
        latencyMs: Date.now() - startedAt,
      });
      throw error;
    } finally {
      await this.releaseSessionLock(ctx, session.id);
    }
  }

  public async handleAction(ctx: KernelRequestContext, request: CopilotActionRequest): Promise<CopilotChatResponse> {
    const session = await this.deps.kernel.copilotServices.sessionService.getSession(ctx.user.id, request.sessionId);
    if (!session) return errorResponse(request.sessionId, request.turnId ?? `ct-${randomUUID()}`, "Session not found.");
    await this.acquireSessionLock(ctx, session.id);
    const run = await this.deps.kernel.platformServices.agentRuns.createRun({
      id: `run-${randomUUID()}`,
      userId: ctx.user.id,
      sessionId: session.id,
      requestId: ctx.request.requestId,
      mode: "action",
      model: this.config.model,
    });
    const startedAt = Date.now();
    try {
    const turnId = request.turnId ?? `ct-${randomUUID()}`;
    const workspace = await this.deps.kernel.copilotServices.workspaceService.getWorkspace(ctx.user.id, session.id);
    const toolName = toolForAction(request.action.type);
    const toolArgs = argsForAction(request.action, workspace);
    const result = await this.executeToolWithLog(toolName, toolArgs, {
      ctx,
      session,
      workspace,
      request: { sessionId: session.id, message: request.action.type, clientState: request.clientState as CopilotChatRequest["clientState"] },
      turnId,
    }, run.id);
    const decision: AgentDecision = {
      mode: "call_tool",
      assistantMessage: "",
      toolCalls: [{ toolName, arguments: toolArgs }],
      confidence: 1,
    };
    const nextWorkspace = mergeWorkspace(session.id, workspace, decision, [result]);
    const response = this.presenter.present({ sessionId: session.id, turnId, decision, toolResults: [result], workspace: nextWorkspace });
    await this.persistResponse(ctx.user.id, response, request.action.type === "accept" ? "save_resume" : request.action.type.startsWith("revise") ? "revision" : "decision");
    await this.deps.kernel.platformServices.agentRuns.completeRun(run.id, { turnId, decisionMode: decision.mode, latencyMs: Date.now() - startedAt });
    return response;
    } catch (error) {
      const mapped = mapError(error);
      await this.deps.kernel.platformServices.agentRuns.failRun(run.id, {
        errorCode: mapped.code,
        errorMessage: mapped.message,
        latencyMs: Date.now() - startedAt,
      });
      throw error;
    } finally {
      await this.releaseSessionLock(ctx, session.id);
    }
  }

  public async handleStream(
    ctx: KernelRequestContext,
    request: CopilotChatRequest,
    emit: (event: CopilotStreamEvent["type"], data: unknown) => void,
  ): Promise<void> {
    try {
      const response = await this.handleChat(ctx, request);
      emit("copilot.turn.started", { type: "copilot.turn.started", sessionId: response.sessionId, turnId: response.turnId });
      emit("copilot.message.created", { type: "copilot.message.created", message: response.assistantMessage });
      for (const item of response.timeline) emit("copilot.timeline.updated", { type: "copilot.timeline.updated", item });
      emit("copilot.workspace.updated", {
        type: "copilot.workspace.updated",
        sessionId: response.sessionId,
        status: response.workspace.status,
        variantCount: response.workspace.variants.length,
      });
      if (response.nextActions.length > 0) emit("copilot.action.required", { type: "copilot.action.required", actions: response.nextActions });
      emit("copilot.completed", { type: "copilot.completed", sessionId: response.sessionId, turnId: response.turnId, workspaceStatus: response.workspace.status });
    } catch (error) {
      emit("copilot.failed", {
        type: "copilot.failed",
        sessionId: request.sessionId ?? "unknown",
        turnId: `ct-${randomUUID()}`,
        message: error instanceof Error ? error.message : "Copilot stream failed.",
      });
    }
  }

  private decisionInput(
    ctx: KernelRequestContext,
    request: CopilotChatRequest,
    session: CopilotSession,
    workspace: CopilotWorkspace | null,
    recentMessages: CopilotMessage[],
  ) {
    return {
      requestId: ctx.request.requestId,
      sessionId: session.id,
      message: request.message,
      request,
      session,
      workspace,
      recentMessages,
      tools: this.tools.getToolSchemas(),
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
      allowDeterministicRouter: this.config.allowDeterministicRouter,
    };
  }

  private decisionToolCallsAreValid(
    decision: AgentDecision,
    input: { requestId: string; sessionId: string },
  ): boolean {
    const calls = decision.toolCalls ?? [];
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

  private async executeDecisionTools(
    ctx: KernelRequestContext,
    request: CopilotChatRequest,
    session: CopilotSession,
    workspace: CopilotWorkspace | null,
    turnId: string,
    decision: AgentDecision,
    ingestionWarnings: string[],
    agentRunId: string,
  ): Promise<AgentToolResult[]> {
    const calls = normalizeToolCalls(decision);
    const results: AgentToolResult[] = [];
    for (const call of calls) {
      await this.deps.kernel.platformServices.usage.consume({ userId: ctx.user.id, metric: "tool_call" });
      if (call.toolName === "generate_resume_variants") {
        await this.deps.kernel.platformServices.usage.consume({ userId: ctx.user.id, metric: "generation" });
        await this.ingestResumeIfNeeded(ctx, session, ingestionWarnings);
      }
      results.push(await this.executeToolWithLog(call.toolName, call.arguments, { ctx, session, workspace, request, turnId }, agentRunId));
    }
    return results;
  }

  private async executeToolWithLog(
    toolName: string,
    args: Record<string, unknown>,
    context: Parameters<AgentToolRegistry["execute"]>[2],
    agentRunId: string,
  ): Promise<AgentToolResult> {
    const startedAt = Date.now();
    const toolRun = await this.deps.kernel.platformServices.agentRuns.createToolRun({
      id: `toolrun-${randomUUID()}`,
      agentRunId,
      userId: context.ctx.user.id,
      sessionId: context.session.id,
      toolName,
      inputSummary: summarizeToolInput(args),
    });
    try {
      const result = await this.tools.execute(toolName, args, context);
      await this.deps.kernel.platformServices.agentRuns.completeToolRun(toolRun.id, {
        status: result.status === "success" ? "completed" : result.status,
        latencyMs: Date.now() - startedAt,
        outputSummary: summarizeToolOutput(result),
      });
      return result;
    } catch (error) {
      const mapped = mapError(error);
      await this.deps.kernel.platformServices.agentRuns.completeToolRun(toolRun.id, {
        status: "failed",
        latencyMs: Date.now() - startedAt,
        errorCode: mapped.code,
        errorMessage: mapped.message,
      });
      throw error;
    }
  }

  private async acquireSessionLock(ctx: KernelRequestContext, sessionId: string): Promise<void> {
    const acquired = await this.deps.kernel.platformServices.sessionLocks.acquire({
      userId: ctx.user.id,
      sessionId,
      ownerRequestId: ctx.request.requestId,
      ttlMs: readPlatformConfig().sessionLockTtlMs,
    });
    if (!acquired) {
      throw new ApiError(ErrorCodes.SESSION_LOCKED, "This session is already processing another request. Please retry shortly.", 409, { retryable: true });
    }
  }

  private async releaseSessionLock(ctx: KernelRequestContext, sessionId: string): Promise<void> {
    await this.deps.kernel.platformServices.sessionLocks.release({
      userId: ctx.user.id,
      sessionId,
      ownerRequestId: ctx.request.requestId,
    });
  }

  private assertPromptWithinLimit(request: CopilotChatRequest): void {
    const length = [request.message, request.resumeText, request.jdText, request.targetRole].filter(Boolean).join("\n").length;
    if (length > readPlatformConfig().maxPromptChars) {
      throw new ApiError(ErrorCodes.QUOTA_EXCEEDED, "Input is too long for a single agent run.", 429, { retryable: false });
    }
  }

  private async synthesizeFinalAnswer(
    decision: AgentDecision,
    toolResults: AgentToolResult[],
    response: CopilotChatResponse,
  ): Promise<string> {
    if (readPlatformConfig().finalAnswerSynthesis !== "llm" || toolResults.length === 0) {
      return response.assistantMessage.content;
    }
    try {
      const result = await this.deps.kernel.frontDeskModelClient?.chat({
        messages: [
          {
            role: "system",
            content: "Write a concise user-facing final answer from safe summaries only. Do not expose tool names, arguments, prompts, chain-of-thought, or provider internals.",
          },
          {
            role: "user",
            content: JSON.stringify({
              decisionMessage: decision.assistantMessage,
              toolResults: toolResults.map((tool) => ({ status: tool.status, assistantMessage: tool.assistantMessage })),
              workspace: {
                activePanel: response.workspace.activePanel,
                variantCount: response.workspace.variants.length,
                experienceCount: response.workspace.experiences?.length ?? 0,
                resumeCount: response.workspace.resumes?.length ?? 0,
                jdCount: response.workspace.jds?.length ?? 0,
              },
            }),
          },
        ],
        temperature: 0.2,
        maxTokens: 500,
      });
      return result?.content?.trim() || response.assistantMessage.content;
    } catch {
      return response.assistantMessage.content;
    }
  }

  private async saveMessage(userId: string, message: CopilotMessage): Promise<CopilotMessage> {
    await this.deps.kernel.copilotServices.sessionService.saveMessage(userId, message);
    return message;
  }

  private async persistResponse(userId: string, response: CopilotChatResponse, activityType: CopilotActivityType): Promise<void> {
    await Promise.all([
      this.deps.kernel.copilotServices.sessionService.saveMessage(userId, response.assistantMessage),
      this.deps.kernel.copilotServices.sessionService.completeTurn(userId, response.turnId, response.assistantMessage.id),
      this.deps.kernel.copilotServices.workspaceService.saveWorkspace(userId, response.workspace),
      this.deps.kernel.copilotServices.workspaceService.recordActivity(userId, {
        sessionId: response.sessionId,
        type: activityType,
        title: activityTitle(activityType),
        description: response.assistantMessage.content.slice(0, 180),
        entityType: response.workspace.activePanel === "variants" ? "generation" : "session",
        entityId: response.workspace.productGenerationId ?? response.sessionId,
      }),
    ]);
  }

  private async ingestResumeIfNeeded(ctx: KernelRequestContext, session: CopilotSession, warnings: string[]): Promise<void> {
    if (!session.resumeText || session.resumeIngested) return;
    try {
      const result = await this.deps.kernel.cvAgentKernel.documents.ingest(ctx, {
        message: "Import resume.",
        documents: [{
          userId: ctx.user.id,
          fileName: "copilot-resume.txt",
          mimeType: "text/plain",
          sourceRef: `copilot:${session.id}`,
          buffer: new TextEncoder().encode(session.resumeText),
        }],
      });
      await this.deps.kernel.copilotServices.sessionService.updateSession(ctx.user.id, session.id, {
        resumeIngested: true,
        resumeDocumentIds: result.extractedDocuments.map((document) => document.documentId),
        resumeArtifactIds: result.evidences.map((evidence) => evidence.id),
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      warnings.push(`Resume ingestion failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
}

function normalizeToolCalls(decision: AgentDecision): Array<{ toolName: string; arguments: Record<string, unknown> }> {
  if (decision.toolCalls?.length) return decision.toolCalls;
  if (decision.mode === "generate") return [{ toolName: "generate_resume_variants", arguments: {} }];
  if (decision.mode === "revise") return [{ toolName: "revise_variant", arguments: {} }];
  if (decision.mode === "explain_workspace") return [{ toolName: "explain_choice", arguments: {} }];
  return [];
}

function mergeWorkspace(
  sessionId: string,
  existing: CopilotWorkspace | null,
  decision: AgentDecision,
  results: AgentToolResult[],
): CopilotWorkspace {
  const base: CopilotWorkspace = existing ?? {
    id: `ws-${sessionId}`,
    sessionId,
    variants: [],
    status: "empty",
    updatedAt: new Date().toISOString(),
  };
  const workspace = { ...base };
  for (const result of results) {
    if (!result.workspacePatch) continue;
    Object.assign(workspace, result.workspacePatch);
    workspace.variants = result.workspacePatch.variants ?? workspace.variants ?? [];
  }
  if (decision.workspaceIntent?.activePanel && isPanel(decision.workspaceIntent.activePanel)) {
    workspace.activePanel = decision.workspaceIntent.activePanel;
  }
  workspace.updatedAt = new Date().toISOString();
  return workspace;
}

function isPanel(value: string): value is NonNullable<CopilotWorkspace["activePanel"]> {
  return ["variants", "experience_library", "resume_history", "resume_editor", "jd_library", "import_candidates"].includes(value);
}

function activityTypeForDecision(decision: AgentDecision, results: AgentToolResult[]): CopilotActivityType {
  const toolNames = new Set(decision.toolCalls?.map((call) => call.toolName) ?? []);
  if (toolNames.has("generate_resume_variants")) return "generation";
  if (toolNames.has("revise_variant")) return "revision";
  if (toolNames.has("save_variant_to_resume")) return "save_resume";
  if (toolNames.has("record_variant_decision")) return "decision";
  if (toolNames.has("import_resume_text")) return "import";
  if (toolNames.has("create_experience")) return "save_experience";
  if (results.some((result) => result.workspacePatch?.activePanel === "variants")) return "generation";
  return "chat";
}

function activityTitle(type: CopilotActivityType): string {
  switch (type) {
    case "generation": return "Generated resume variants";
    case "revision": return "Revised a variant";
    case "decision": return "Recorded a variant decision";
    case "import": return "Imported resume text";
    case "save_experience": return "Saved an experience";
    case "save_resume": return "Saved a variant to resume";
    default: return "Copilot chat";
  }
}

function toolForAction(type: ProductAction["type"]): string {
  switch (type) {
    case "revise_more_conservative":
    case "revise_more_quantified":
      return "revise_variant";
    case "show_evidence":
      return "show_evidence";
    case "explain_choice":
      return "explain_choice";
    case "accept":
      return "save_variant_to_resume";
    case "reject":
    case "prefer":
    case "confirm_metric":
      return "record_variant_decision";
  }
}

function argsForAction(
  action: CopilotActionRequest["action"],
  workspace: CopilotWorkspace | null,
): Record<string, unknown> {
  const variantId = action.variantId ?? workspace?.activeVariantId ?? workspace?.variants[0]?.id;
  if (action.type === "accept") {
    return { generationId: workspace?.productGenerationId, variantId, resumeId: workspace?.resumeId };
  }
  if (action.type === "revise_more_conservative") {
    return { variantId, instruction: "make_more_conservative" };
  }
  if (action.type === "revise_more_quantified") {
    return { variantId, instruction: "make_more_quantified" };
  }
  if (action.type === "show_evidence" || action.type === "explain_choice") {
    return { variantId };
  }
  return { variantId, decision: action.type, payload: action.payload };
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

function errorResponse(sessionId: string, turnId: string, message: string): CopilotChatResponse {
  const now = new Date().toISOString();
  return {
    sessionId,
    turnId,
    assistantMessage: {
      id: `msg-${turnId}-assistant`,
      sessionId,
      turnId,
      role: "assistant",
      content: message,
      kind: "plain_text",
      createdAt: now,
    },
    timeline: [{ id: `tl-${turnId}-error`, type: "warning", title: "Error", status: "failed", createdAt: now }],
    workspace: { id: `ws-${sessionId}`, sessionId, variants: [], status: "empty", updatedAt: now },
    nextActions: [],
    raw: { artifactIds: [], evidenceChainIds: [], critiqueItemIds: [], decisionIds: [] },
  };
}
