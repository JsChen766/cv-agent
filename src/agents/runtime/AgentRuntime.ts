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
} from "../../copilot/types.js";
import { CopilotPresenter } from "../../copilot/CopilotPresenter.js";
import { AgentToolRegistry } from "../tools/AgentToolRegistry.js";
import { FrontDeskAgent } from "../frontdesk/FrontDeskAgent.js";
import { readAgentRuntimeConfig, type AgentRuntimeConfig } from "./AgentRuntimeConfig.js";
import type { AgentDecision } from "../schema/AgentDecision.js";
import { ActivityRecorder } from "./ActivityRecorder.js";
import { AgentQuotaGuard } from "./AgentQuotaGuard.js";
import { AgentRunLogger } from "./AgentRunLogger.js";
import { AgentSessionLock } from "./AgentSessionLock.js";
import { FinalAnswerSynthesizer } from "./FinalAnswerSynthesizer.js";
import { ResumeIngestionCoordinator } from "./ResumeIngestionCoordinator.js";
import { StreamEmitter } from "./StreamEmitter.js";
import { ToolExecutionService } from "./ToolExecutionService.js";
import {
  activityTypeForDecision,
  argsForAction,
  mergeWorkspace,
  toolForAction,
} from "./WorkspaceMerger.js";

export type AgentRuntimeDeps = {
  kernel: ApiKernel;
  config?: AgentRuntimeConfig;
};

export class AgentRuntime {
  private readonly config: AgentRuntimeConfig;
  private readonly tools: AgentToolRegistry;
  private readonly frontDesk: FrontDeskAgent;
  private readonly presenter = new CopilotPresenter();
  private readonly quota: AgentQuotaGuard;
  private readonly locks: AgentSessionLock;
  private readonly runLogger: AgentRunLogger;
  private readonly toolExecution: ToolExecutionService;
  private readonly finalAnswers: FinalAnswerSynthesizer;
  private readonly recorder: ActivityRecorder;
  private readonly streamEmitter = new StreamEmitter();

  public constructor(private readonly deps: AgentRuntimeDeps) {
    this.config = deps.config ?? readAgentRuntimeConfig();
    this.tools = new AgentToolRegistry(deps.kernel);
    if (!deps.kernel.frontDeskModelClient) {
      throw new Error("frontDeskModelClient is required for AgentRuntime.");
    }
    this.frontDesk = new FrontDeskAgent({ modelClient: deps.kernel.frontDeskModelClient });
    this.quota = new AgentQuotaGuard(deps.kernel);
    this.locks = new AgentSessionLock(deps.kernel);
    this.runLogger = new AgentRunLogger(deps.kernel);
    const resumeIngestion = new ResumeIngestionCoordinator(deps.kernel);
    this.toolExecution = new ToolExecutionService(this.tools, this.quota, this.runLogger, resumeIngestion);
    this.finalAnswers = new FinalAnswerSynthesizer(deps.kernel);
    this.recorder = new ActivityRecorder(deps.kernel);
  }

  public async getSession(userId: string, sessionId: string): Promise<CopilotSession | undefined> {
    return (await this.deps.kernel.copilotServices.sessionService.getSession(userId, sessionId)) ?? undefined;
  }

  public async handleChat(
    ctx: KernelRequestContext,
    request: CopilotChatRequest,
  ): Promise<CopilotChatResponse & { ingestionWarnings: string[] }> {
    const ingestionWarnings: string[] = [];
    this.quota.assertPromptWithinLimit(request);
    await this.quota.consumeMessage(ctx.user.id);
    const session = await this.deps.kernel.copilotServices.sessionService.getOrCreateSession(ctx.user.id, {
      sessionId: request.sessionId,
      resumeText: request.resumeText,
      jdText: request.jdText,
      targetRole: request.targetRole,
    });

    await this.locks.acquire(ctx, session.id);
    const run = await this.runLogger.createRun({ ctx, sessionId: session.id, mode: this.config.frontDeskAgentMode, model: this.config.model });
    const startedAt = Date.now();
    try {
      const userMessage = await this.recorder.saveUserMessage(ctx.user.id, userMessageFor(session, request.message));
      const turn = await this.deps.kernel.copilotServices.sessionService.createTurn(ctx.user.id, session.id, userMessage.id);
      const [workspace, recentMessages] = await Promise.all([
        this.deps.kernel.copilotServices.workspaceService.getWorkspace(ctx.user.id, session.id),
        this.deps.kernel.copilotServices.sessionService.getRecentMessages(ctx.user.id, session.id, 6),
      ]);
      let decision = await this.frontDesk.decide(this.decisionInput(ctx, request, session, workspace, recentMessages));
      decision = this.toolExecution.sanitizeDecision(decision, { requestId: ctx.request.requestId, sessionId: session.id });

      const toolResults = await this.toolExecution.executeDecisionTools(
        { ctx, session, workspace, request, turnId: turn.id },
        decision,
        ingestionWarnings,
        run.id,
      );
      const response = this.present(session.id, turn.id, decision, workspace, toolResults);
      response.assistantMessage.content = await this.finalAnswers.synthesize(decision, toolResults, response);

      await this.recorder.persistResponse(ctx.user.id, response, activityTypeForDecision(decision, toolResults));
      await this.runLogger.completeRun(run.id, { turnId: turn.id, decisionMode: decision.mode, startedAt });
      return { ...response, ingestionWarnings };
    } catch (error) {
      await this.runLogger.failRun(run.id, error, startedAt);
      throw error;
    } finally {
      await this.locks.release(ctx, session.id);
    }
  }

  public async handleAction(ctx: KernelRequestContext, request: CopilotActionRequest): Promise<CopilotChatResponse> {
    const session = await this.deps.kernel.copilotServices.sessionService.getSession(ctx.user.id, request.sessionId);
    if (!session) return errorResponse(request.sessionId, request.turnId ?? `ct-${randomUUID()}`, "Session not found.");

    await this.locks.acquire(ctx, session.id);
    const run = await this.runLogger.createRun({ ctx, sessionId: session.id, mode: "action", model: this.config.model });
    const startedAt = Date.now();
    try {
      const turnId = request.turnId ?? `ct-${randomUUID()}`;
      const workspace = await this.deps.kernel.copilotServices.workspaceService.getWorkspace(ctx.user.id, session.id);
      const toolName = toolForAction(request.action.type);
      const toolArgs = argsForAction(request.action, workspace);
      const toolResult = await this.toolExecution.executeToolWithLog(toolName, toolArgs, {
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
      const response = this.present(session.id, turnId, decision, workspace, [toolResult]);
      await this.recorder.persistResponse(ctx.user.id, response, request.action.type === "accept" ? "save_resume" : request.action.type.startsWith("revise") ? "revision" : "decision");
      await this.runLogger.completeRun(run.id, { turnId, decisionMode: decision.mode, startedAt });
      return response;
    } catch (error) {
      await this.runLogger.failRun(run.id, error, startedAt);
      throw error;
    } finally {
      await this.locks.release(ctx, session.id);
    }
  }

  public async handleStream(
    ctx: KernelRequestContext,
    request: CopilotChatRequest,
    emit: (event: CopilotStreamEvent["type"], data: unknown) => void,
  ): Promise<void> {
    try {
      this.streamEmitter.emitResponse(await this.handleChat(ctx, request), emit);
    } catch (error) {
      this.streamEmitter.emitFailure(request, error, emit);
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

  private present(
    sessionId: string,
    turnId: string,
    decision: AgentDecision,
    workspace: CopilotWorkspace | null,
    toolResults: Parameters<CopilotPresenter["present"]>[0]["toolResults"],
  ): CopilotChatResponse {
    return this.presenter.present({
      sessionId,
      turnId,
      decision,
      toolResults,
      workspace: mergeWorkspace(sessionId, workspace, decision, toolResults),
    });
  }
}

function userMessageFor(session: CopilotSession, content: string): CopilotMessage {
  return {
    id: `msg-${randomUUID()}`,
    sessionId: session.id,
    role: "user",
    content,
    kind: "plain_text",
    createdAt: new Date().toISOString(),
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
