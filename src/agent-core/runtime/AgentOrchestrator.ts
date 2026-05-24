import { randomUUID } from "node:crypto";
import type { ApiKernel } from "../../api/types.js";
import { ActiveAssetContextBuilder, type ActiveAssetContext } from "../../copilot/ActiveAssetContextBuilder.js";
import { UserAssetContextBuilder } from "../../copilot/context/UserAssetContextBuilder.js";
import { ContextHydrator, toolNeedsInputMessage, toolNeedsInputMessageForFields } from "../../copilot/context/ContextHydrator.js";
import { applyHandoffToDrafts, mostRecentJDDraft } from "../../copilot/context/DraftContext.js";
import { normalizeFrontDeskHandoff } from "../../copilot/handoff/HandoffNormalizer.js";
import type { FrontDeskHandoff } from "../../copilot/handoff/FrontDeskHandoff.js";
import type {
  CopilotActionRequest,
  CopilotActionResult,
  CopilotChatRequest,
  CopilotChatResponse,
  CopilotMessage,
  CopilotWorkspace,
  ProductTimelineItem,
} from "../../copilot/types.js";
import { detectLocale, type CopilotLocale } from "../../copilot/locale.js";
import { ResponseComposer } from "../../copilot/response/ResponseComposer.js";
import { isBlockedToolLog } from "../../copilot/response/ProductReplyTemplates.js";
import { isCanonicalExperienceId, isCanonicalGenerationId, isCanonicalJDId, isCanonicalResumeId, isCanonicalVariantId } from "../../copilot/context/IdGuards.js";
import { defaultToolResultVisibility } from "../../copilot/response/ToolResultVisibility.js";
import { affectedResourcesFor } from "../security/ToolAffectedResources.js";
import { guardToolIds, stripInternalToolArgs } from "../security/ToolIdGuard.js";
import { sanitizeExperiencePatch } from "../security/ToolPatchSanitizer.js";
import { guardToolScope } from "../security/ToolScopeGuard.js";
import { tasksFromHandoff } from "../../copilot/tasks/TaskStateReducer.js";
import { createAgentTools } from "../../agent-tools/index.js";
import type { PendingAction } from "../confirmation/PendingAction.js";
import { PendingActionService } from "../confirmation/PendingActionService.js";
import { ArchitectAgent } from "../agents/ArchitectAgent.js";
import { getAgentDecisionMeta, type Agent } from "../agents/BaseAgent.js";
import { CriticAgent } from "../agents/CriticAgent.js";
import { ExperienceReceiverAgent } from "../agents/ExperienceReceiverAgent.js";
import { FrontDeskAgent } from "../agents/FrontDeskAgent.js";
import { StrategistAgent } from "../agents/StrategistAgent.js";
import { PromptRegistry } from "../prompts/PromptRegistry.js";
import type { ToolDefinition } from "../tools/Tool.js";
import { ToolExecutor } from "../tools/ToolExecutor.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolResult } from "../tools/ToolResult.js";
import type { AgentName, CriticReview, PlanStep } from "../validation/AgentOutputSchemas.js";
import type { KernelRequestContext } from "../../api/context.js";
import type { AgentContext } from "./AgentContext.js";
import { AgentError } from "./AgentError.js";
import { AgentLoopController } from "./AgentLoopController.js";
import { AgentMessageBus } from "./AgentMessageBus.js";
import type { AgentObservation, AgentObservationStatus } from "./AgentObservation.js";
import { AgentTraceRecorder } from "./AgentTrace.js";
import type { AgentRuntimeEmitter, AgentStreamEventType } from "./AgentStreamEvent.js";
import { CriticGate, shouldReviewTool, type ToolExecutionRecord } from "./CriticGate.js";

export { guardToolIds } from "../security/ToolIdGuard.js";

export type AgentOrchestratorDeps = {
  kernel: ApiKernel;
  pendingActions?: PendingActionService;
};

type RunState = {
  context: AgentContext;
  trace: AgentTraceRecorder;
  executor: ToolExecutor;
  workspace: CopilotWorkspace | null;
  messageBus: AgentMessageBus;
  loopController: AgentLoopController;
  streamEmitter?: AgentRuntimeEmitter;
};

type ExecutedPlan = {
  toolResults: ToolResult[];
  pendingActions: PendingAction[];
  executions: ToolExecutionRecord[];
};

type LoopRunResult = {
  assistantText: string;
  toolResults: ToolResult[];
  pendingActions: PendingAction[];
  workspacePatch: Record<string, unknown>;
  criticReview?: CriticReview;
};

export class AgentOrchestrator {
  public readonly pendingActions: PendingActionService;
  public readonly tools: ToolRegistry;
  private readonly activeAssetContextBuilder: ActiveAssetContextBuilder;
  private readonly userAssetContextBuilder: UserAssetContextBuilder;
  private readonly contextHydrator = new ContextHydrator();
  private readonly responseComposer = new ResponseComposer();
  private readonly agents: Record<AgentName, Agent>;

  public constructor(private readonly deps: AgentOrchestratorDeps) {
    const promptRegistry = new PromptRegistry();
    this.pendingActions = deps.pendingActions ?? new PendingActionService();
    this.tools = new ToolRegistry();
    this.tools.registerMany(createAgentTools());
    this.activeAssetContextBuilder = new ActiveAssetContextBuilder(deps.kernel);
    this.userAssetContextBuilder = new UserAssetContextBuilder(deps.kernel);
    const modelClient = deps.kernel.frontDeskModelClient;
    this.agents = {
      frontdesk: new FrontDeskAgent({ modelClient, promptRegistry }),
      experience_receiver: new ExperienceReceiverAgent({ modelClient, promptRegistry }),
      strategist: new StrategistAgent({ modelClient, promptRegistry }),
      architect: new ArchitectAgent({ modelClient, promptRegistry }),
      critic: new CriticAgent({ modelClient, promptRegistry }),
    };
  }

  public getSession(userId: string, sessionId: string) {
    return this.deps.kernel.copilotServices.sessionService.getSession(userId, sessionId);
  }

  public handleChat(ctx: KernelRequestContext, request: CopilotChatRequest): Promise<CopilotChatResponse> {
    return this.handleChatInternal(ctx, request);
  }

  public handleChatStream(
    ctx: KernelRequestContext,
    request: CopilotChatRequest,
    emit: AgentRuntimeEmitter,
  ): Promise<CopilotChatResponse> {
    return this.handleChatInternal(ctx, request, emit);
  }

  private async handleChatInternal(
    ctx: KernelRequestContext,
    request: CopilotChatRequest,
    streamEmitter?: AgentRuntimeEmitter,
  ): Promise<CopilotChatResponse> {
    const session = await this.deps.kernel.copilotServices.sessionService.getOrCreateSession(ctx.user.id, {
      sessionId: request.sessionId,
      resumeText: request.resumeText,
      jdText: request.jdText,
      targetRole: request.targetRole,
    });
    const userMessage = await this.saveMessage(ctx.user.id, session.id, "user", request.message);
    const turn = await this.deps.kernel.copilotServices.sessionService.createTurn(ctx.user.id, session.id, userMessage.id);
    const run = await this.buildAgentContext(ctx, {
      sessionId: session.id,
      turnId: turn.id,
      userMessage: request.message,
      request,
      productContext: {
        targetRole: request.targetRole ?? session.targetRole,
        hasJDText: Boolean(request.jdText ?? session.jdText),
        requestJDText: request.jdText ?? session.jdText ?? undefined,
      },
      streamEmitter,
    });
    this.emit(run, "agent.turn.started", "开始处理请求", {
      status: "running",
    });

    try {
      this.emit(run, "agent.thinking", "正在思考…", { agentName: "frontdesk", status: "running" });
      this.emit(run, "agent.route.started", "正在判断任务类型…", { agentName: "frontdesk", status: "running" });
      const frontDeskStep = run.trace.add({
        agentName: "frontdesk",
        type: "reason",
        summary: "Classifying and routing the user request.",
        status: "running",
      });
      const frontDeskDecision = await this.agents.frontdesk.decide({ context: run.context });
      const normalizedHandoff = normalizeFrontDeskHandoff({
        raw: frontDeskDecision.handoff,
        sessionId: run.context.sessionId,
        turnId: run.context.turnId,
        userMessage: request.message,
        routeTo: frontDeskDecision.routeTo,
        responseType: frontDeskDecision.responseType,
        confidence: frontDeskDecision.confidence,
        missingInputs: frontDeskDecision.missingInputs,
        clientState: request.clientState,
        workspace: run.workspace,
      });
      this.applyHandoff(run, normalizedHandoff.handoff, normalizedHandoff.repaired ? normalizedHandoff.reason : undefined);
      run.trace.complete(frontDeskStep, "success", {
        routeTo: frontDeskDecision.routeTo,
        responseType: frontDeskDecision.responseType,
        handoff: normalizedHandoff.handoff,
        decision: decisionTraceMeta(frontDeskDecision),
      });
      this.emit(run, "agent.route.completed", "任务类型判断完成", {
        agentName: "frontdesk",
        status: frontDeskDecision.responseType,
        payload: {
          routeTo: frontDeskDecision.routeTo,
          responseType: frontDeskDecision.responseType,
        },
      });

      if (normalizedHandoff.handoff.intent === "jd.intake" && normalizedHandoff.handoff.next === "handoff") {
        return this.finishRun(ctx.user.id, run, {
          assistantText: frontDeskDecision.assistantMessage,
          toolResults: [],
          pendingActions: [],
          workspacePatch: {},
        });
      }

      if (frontDeskDecision.responseType === "final") {
        return this.finishRun(ctx.user.id, run, {
          assistantText: frontDeskDecision.assistantMessage || t(run, "productIntro"),
          toolResults: [],
          pendingActions: [],
          workspacePatch: {},
        });
      }

      if (frontDeskDecision.responseType === "ask_clarification") {
        return this.finishRun(ctx.user.id, run, {
          assistantText: frontDeskDecision.assistantMessage || t(run, "clarify"),
          toolResults: [],
          pendingActions: [],
          workspacePatch: {},
        });
      }

      if (!frontDeskDecision.routeTo) {
        return this.finishRun(ctx.user.id, run, {
          assistantText: t(run, "unknownRequest"),
          toolResults: [],
          pendingActions: [],
          workspacePatch: {},
        });
      }

      const specialist = this.agents[frontDeskDecision.routeTo];
      const executed = await this.runSpecialistLoop(run, specialist, frontDeskDecision.routeTo);
      return this.finishRun(ctx.user.id, run, {
        ...executed,
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Agent run failed.";
      this.emit(run, "agent.failed", "处理失败", {
        status: "failed",
        message: errorMessage,
        payload: { message: errorMessage },
      });
      return this.finishError(ctx.user.id, run, error, { skipCompletedEmit: true });
    }
  }

  public async handleExplicitAction(ctx: KernelRequestContext, request: CopilotActionRequest): Promise<CopilotChatResponse> {
    const session = await this.deps.kernel.copilotServices.sessionService.getSession(ctx.user.id, request.sessionId);
    if (!session) {
      throw new AgentError("PRODUCT_STATE_NOT_FOUND", "Session not found.", { statusCode: 404 });
    }
    const userMessage = await this.saveMessage(ctx.user.id, session.id, "user", `[action] ${request.action.type}`);
    const turn = await this.deps.kernel.copilotServices.sessionService.createTurn(ctx.user.id, session.id, userMessage.id);
    const run = await this.buildAgentContext(ctx, {
      sessionId: session.id,
      turnId: turn.id,
      userMessage: `[action] ${request.action.type}`,
      request: {
        sessionId: session.id,
        message: `[action] ${request.action.type}`,
        clientState: request.clientState,
      },
      productContext: { explicitAction: request.action.type },
    });

    const mapped = this.mapExplicitAction(request, run);
    if (mapped.kind === "unsupported") {
      const runLocale = localeFor(run);
      const result = failedActionResult(request.action.type, text(runLocale, "unsupportedAction"));
      return this.finishRun(ctx.user.id, run, {
        assistantText: result.message ?? text(runLocale, "unsupportedAction"),
        toolResults: [result],
        pendingActions: [],
        workspacePatch: {},
      });
    }

    if (mapped.kind === "needs_input") {
      const runLocale = localeFor(run);
      const result: ToolResult = {
        status: "needs_input",
        message: mapped.message,
        visibility: "error_user_visible",
        actionResult: {
          actionType: request.action.type,
          status: "needs_input",
          missingInputs: mapped.missingInputs,
          message: mapped.message,
        },
      };
      return this.finishRun(ctx.user.id, run, {
        assistantText: mapped.message,
        toolResults: [result],
        pendingActions: [],
        workspacePatch: {},
      });
    }

    try {
      const executed = await this.executePlan(run, [mapped.step]);
      return this.finishRun(ctx.user.id, run, {
        assistantText: assistantFromResults(executed.toolResults, t(run, "done")),
        toolResults: executed.toolResults,
        pendingActions: executed.pendingActions,
        workspacePatch: mergeWorkspacePatch(executed.toolResults),
      });
    } catch (error) {
      return this.finishError(ctx.user.id, run, error);
    }
  }

  public async confirmPendingAction(ctx: KernelRequestContext, id: string): Promise<CopilotChatResponse> {
    const action = await this.pendingActions.get(ctx.user.id, id);
    if (!action) throw new AgentError("PERMISSION_DENIED", "Pending action not found.", { statusCode: 404 });
    const session = await this.deps.kernel.copilotServices.sessionService.getSession(ctx.user.id, action.sessionId);
    if (!session) throw new AgentError("PRODUCT_STATE_NOT_FOUND", "Session not found.", { statusCode: 404 });
    const run = await this.buildAgentContext(ctx, {
      sessionId: session.id,
      turnId: action.turnId ?? `ct-${randomUUID()}`,
      userMessage: `[confirm] ${action.toolName}`,
      request: { sessionId: session.id, message: `[confirm] ${action.toolName}` },
      productContext: { pendingActionId: id },
    });
    const confirmed = await this.pendingActions.confirm({
      userId: ctx.user.id,
      id,
      registry: this.tools,
      executor: run.executor,
      context: run.context,
      workspace: run.workspace,
    });
    const confirmedAction = confirmed.action;
    const result = ensureToolResultVisibility(confirmed.result, confirmedAction.toolName);
    const tool = this.tools.get(confirmedAction.toolName);
    const step = confirmedActionStep(confirmedAction, tool?.ownerAgent ?? "frontdesk");
    const execution: ToolExecutionRecord = { step, result };
    const confirmSucceeded = result.status === "success";
    this.addObservation(run, step, result);
    run.trace.add({
      agentName: "AgentOrchestrator",
      type: "final",
      summary: confirmSucceeded ? `Executed pending action ${id}.` : `Blocked pending action ${id}.`,
      status: confirmSucceeded ? "success" : result.status,
      completedAt: new Date().toISOString(),
      metadata: {
        pendingActionId: id,
        toolName: confirmedAction.toolName,
        resultStatus: result.status,
        reason: result.actionResult?.reason,
      },
    });
    if (!confirmSucceeded) {
      return this.finishRun(ctx.user.id, run, {
        assistantText: result.message ?? "This pending action is no longer valid. Please start it again.",
        toolResults: [result],
        pendingActions: [],
        workspacePatch: {},
      });
    }
    if (shouldReviewTool(confirmedAction.toolName)) {
      this.emit(run, "agent.critic.started", "正在审查结果…", {
        agentName: "critic",
        status: "running",
      });
      const gateResult = await this.createCriticGate(run).review({
        context: run.context,
        toolExecutions: [execution],
        sourceAgent: step.agentName,
      });
      this.emit(run, "agent.critic.completed", labelForCriticStatus(gateResult.status), {
        agentName: "critic",
        status: gateResult.status,
        payload: { verdict: gateResult.review?.verdict },
      });
      const criticReview = gateResult.review;

      if (gateResult.status === "blocked") {
        const message = criticReview?.userVisibleSummary || "该结果存在较高风险，已暂时拦截，请补充真实依据后再继续。";
        return this.finishRun(ctx.user.id, run, {
          assistantText: message,
          toolResults: [failedActionResult("critic_gate", message, "critic_blocked")],
          pendingActions: [],
          workspacePatch: {},
          criticReview,
        });
      }

      if (gateResult.status === "needs_user_confirmation") {
        const message = criticReview?.userVisibleSummary || t(run, "confirmFacts");
        return this.finishRun(ctx.user.id, run, {
          assistantText: message,
          toolResults: [needsConfirmationResult(message)],
          pendingActions: [],
          workspacePatch: {},
          criticReview,
        });
      }

      if (gateResult.status === "needs_revision") {
        const revision = run.messageBus.requestRevision("critic", step.agentName, { review: criticReview });
        run.context.agentMessages = run.messageBus.list();
        run.trace.add({
          agentName: "AgentOrchestrator",
          type: "reason",
          summary: "Recorded critic revision request for confirmed action.",
          status: "success",
          completedAt: new Date().toISOString(),
          metadata: { messageId: revision.id },
        });
        run.loopController.stop("critic_needs_revision");
        this.syncLoopState(run);
        const message = criticRevisionMessage(criticReview, localeFor(run));
        return this.finishRun(ctx.user.id, run, {
          assistantText: message,
          toolResults: [result, ...gateResult.criticToolResults, needsRevisionResult(message)],
          pendingActions: [],
          workspacePatch: {},
          criticReview,
        });
      }

      return this.finishRun(ctx.user.id, run, {
        assistantText: result.message ?? t(run, "confirmedExecuted"),
        toolResults: [result, ...gateResult.criticToolResults],
        pendingActions: [],
        workspacePatch: mergeWorkspacePatch([result]),
        criticReview,
      });
    }

    return this.finishRun(ctx.user.id, run, {
      assistantText: result.message ?? t(run, "confirmedExecuted"),
      toolResults: [result],
      pendingActions: [],
      workspacePatch: mergeWorkspacePatch([result]),
    });
  }

  private emit(
    run: RunState,
    type: AgentStreamEventType,
    label: string,
    extra: {
      agentName?: AgentName | "AgentOrchestrator" | "ToolExecutor";
      toolName?: string;
      status?: string;
      message?: string;
      payload?: Record<string, unknown>;
      response?: CopilotChatResponse;
    } = {},
  ): void {
    run.streamEmitter?.({
      type,
      sessionId: run.context.sessionId,
      turnId: run.context.turnId,
      createdAt: new Date().toISOString(),
      label,
      ...extra,
    });
  }

  private async buildAgentContext(
    ctx: KernelRequestContext,
    input: {
      sessionId: string;
      turnId: string;
      userMessage: string;
      request: CopilotChatRequest;
      productContext: Record<string, unknown>;
      streamEmitter?: AgentRuntimeEmitter;
    },
  ): Promise<RunState> {
    const [workspace, recentMessages] = await Promise.all([
      this.deps.kernel.copilotServices.workspaceService.getWorkspace(ctx.user.id, input.sessionId),
      this.deps.kernel.copilotServices.sessionService.getRecentMessages(ctx.user.id, input.sessionId, 8),
    ]);
    const trace = new AgentTraceRecorder();
    const messageBus = new AgentMessageBus(trace.trace.runId, input.turnId);
    const loopController = new AgentLoopController();
    const activeAsset = await this.activeAssetContextBuilder.build({ userId: ctx.user.id, request: input.request, workspace });
    const userAsset = await this.userAssetContextBuilder.build({
      userId: ctx.user.id,
      workspace,
      clientState: input.request.clientState,
      activeAssetContext: activeAsset,
      productContext: input.productContext,
      userMessage: input.userMessage,
    });
    const context: AgentContext = {
      kernel: this.deps.kernel,
      requestContext: ctx,
      userId: ctx.user.id,
      sessionId: input.sessionId,
      turnId: input.turnId,
      userMessage: input.userMessage,
      recentMessages,
      workspace,
      clientState: input.request.clientState,
      activeAssetContext: activeAsset,
      userAssetContext: userAsset,
      productContext: input.productContext,
      availableTools: this.tools.list(),
      trace: trace.trace,
      observations: [],
      agentMessages: [],
      loopState: loopController.state,
    };
    trace.add({
      agentName: "AgentOrchestrator",
      type: "reason",
      summary: "Built user asset manifest.",
      status: "success",
      completedAt: new Date().toISOString(),
      metadata: {
        counts: userAsset.counts,
        active: userAsset.active,
        experienceIds: userAsset.experiences.map((item) => item.id),
        jdIds: userAsset.jds.map((item) => item.id),
        resumeIds: userAsset.resumes.map((item) => item.id),
      },
    });
    return {
      context,
      trace,
      executor: new ToolExecutor(this.tools, trace),
      workspace,
      messageBus,
      loopController,
      streamEmitter: input.streamEmitter,
    };
  }

  private applyHandoff(
    run: RunState,
    handoff: NonNullable<CopilotWorkspace["handoffs"]>[number],
    repairReason?: string,
  ): void {
    const now = new Date().toISOString();
    const base = run.workspace ?? {
      id: `ws-${run.context.sessionId}`,
      sessionId: run.context.sessionId,
      variants: [],
      status: "empty" as const,
      updatedAt: now,
    };
    const draftPatch = applyHandoffToDrafts(base, handoff, now);
    const withDrafts = { ...base, ...draftPatch };
    const taskPatch = tasksFromHandoff(withDrafts, handoff, now);
    const handoffs = [...(base.handoffs ?? []), handoff].slice(-8);
    run.workspace = {
      ...withDrafts,
      ...taskPatch,
      handoffs,
      updatedAt: now,
    };
    run.context.workspace = run.workspace;
    run.context.productContext = {
      ...run.context.productContext,
      frontDeskHandoff: handoff,
      requestJDText: handoff.extracted.jdText ?? run.context.productContext.requestJDText,
    };
    run.trace.add({
      agentName: "AgentOrchestrator",
      type: "reason",
      summary: "Stored frontdesk handoff and draft context.",
      status: "success",
      completedAt: now,
      metadata: {
        handoffId: handoff.id,
        intent: handoff.intent,
        routeTo: handoff.routeTo,
        repairReason,
        active: run.workspace.active,
      },
    });
  }

  private async runSpecialistLoop(run: RunState, specialist: Agent, routeHint: AgentName): Promise<LoopRunResult> {
    const toolResults: ToolResult[] = [];
    const pendingActions: PendingAction[] = [];
    let lastAssistantMessage = "";
    let criticReview: CriticReview | undefined;

    while (run.loopController.canContinue()) {
      run.loopController.markStep();
      this.syncLoopState(run);
      const planStep = run.trace.add({
        agentName: specialist.name,
        type: "plan",
        summary: `Planning with ${specialist.name}.`,
        status: "running",
        metadata: { loopStep: run.loopController.state.stepCount },
      });
      this.emit(run, "agent.agent.started", labelForAgentStarted(specialist.name), {
        agentName: specialist.name,
        status: "running",
        payload: { loopStep: run.loopController.state.stepCount },
      });
      const decision = await specialist.decide({ context: run.context, routeHint });
      lastAssistantMessage = decision.assistantMessage || lastAssistantMessage;
      run.trace.complete(planStep, "success", {
        responseType: decision.responseType,
        stepCount: decision.plan.length,
        loopStep: run.loopController.state.stepCount,
        decision: decisionTraceMeta(decision),
      });
      this.emit(run, "agent.agent.completed", "阶段处理完成", {
        agentName: specialist.name,
        status: decision.responseType,
        payload: { responseType: decision.responseType, stepCount: decision.plan.length },
      });

      if (decision.responseType === "final") {
        run.loopController.stop("final");
        this.syncLoopState(run);
        return {
          assistantText: decision.assistantMessage || assistantFromResults(toolResults, t(run, "done")),
          toolResults,
          pendingActions,
          workspacePatch: mergeWorkspacePatch(toolResults),
          criticReview,
        };
      }

      if (decision.responseType === "ask_clarification") {
        run.loopController.stop("needs_input");
        this.syncLoopState(run);
        return {
          assistantText: decision.assistantMessage || t(run, "clarify"),
          toolResults,
          pendingActions,
          workspacePatch: mergeWorkspacePatch(toolResults),
          criticReview,
        };
      }

      if (decision.plan.length === 0) {
        run.loopController.stop("final");
        this.syncLoopState(run);
        return {
          assistantText: decision.assistantMessage || t(run, "needSpecificAction"),
          toolResults,
          pendingActions,
          workspacePatch: mergeWorkspacePatch(toolResults),
          criticReview,
        };
      }

      const plan = this.validatePlan(decision.plan, specialist);
      const executed = await this.executePlan(run, plan);
      toolResults.push(...executed.toolResults);
      pendingActions.push(...executed.pendingActions);

      const stopStatus = firstStopStatus(executed.toolResults);
      if (stopStatus) {
        run.loopController.stop(stopStatus);
        this.syncLoopState(run);
        return {
          assistantText: assistantFromResults(executed.toolResults, lastAssistantMessage || t(run, "done")),
          toolResults,
          pendingActions,
          workspacePatch: mergeWorkspacePatch(toolResults),
          criticReview,
        };
      }

      const willReview = shouldEmitCriticReview(executed.executions);
      if (willReview) {
        this.emit(run, "agent.critic.started", "正在审查结果…", {
          agentName: "critic",
          status: "running",
        });
      }
      const gateResult = await this.createCriticGate(run).review({
        context: run.context,
        toolExecutions: executed.executions,
        sourceAgent: specialist.name,
      });
      if (willReview) {
        this.emit(run, "agent.critic.completed", labelForCriticStatus(gateResult.status), {
          agentName: "critic",
          status: gateResult.status,
          payload: { verdict: gateResult.review?.verdict },
        });
      }
      if (gateResult.criticToolResults.length > 0) toolResults.push(...gateResult.criticToolResults);
      criticReview = gateResult.review ?? criticReview;

      if (gateResult.status === "blocked") {
        run.loopController.stop("critic_blocked");
        this.syncLoopState(run);
        return {
          assistantText: gateResult.review?.userVisibleSummary ?? t(run, "criticBlocked"),
          toolResults: [failedActionResult("critic_gate", gateResult.review?.userVisibleSummary ?? t(run, "criticBlocked"), "critic_blocked")],
          pendingActions,
          workspacePatch: {},
          criticReview,
        };
      }

      if (gateResult.status === "needs_user_confirmation") {
        run.loopController.stop("needs_confirmation");
        this.syncLoopState(run);
        return {
          assistantText: gateResult.review?.userVisibleSummary ?? t(run, "confirmHighRisk"),
          toolResults: [needsConfirmationResult(gateResult.review?.userVisibleSummary ?? t(run, "confirmHighRisk"))],
          pendingActions,
          workspacePatch: {},
          criticReview,
        };
      }

      if (gateResult.status === "needs_revision") {
        const revision = run.messageBus.requestRevision("critic", specialist.name, { review: gateResult.review });
        run.context.agentMessages = run.messageBus.list();
        run.trace.add({
          agentName: "AgentOrchestrator",
          type: "reason",
          summary: "Requested specialist revision from critic feedback.",
          status: "success",
          completedAt: new Date().toISOString(),
          metadata: { messageId: revision.id },
        });
        run.loopController.stop("critic_needs_revision");
        this.syncLoopState(run);
        const message = criticRevisionMessage(gateResult.review, localeFor(run));
        toolResults.push(needsRevisionResult(message));
        return {
          assistantText: message,
          toolResults,
          pendingActions,
          workspacePatch: {},
          criticReview,
        };
      }
    }

    run.loopController.stop("max_steps");
    this.syncLoopState(run);
    return {
      assistantText: `${assistantFromResults(toolResults, lastAssistantMessage || t(run, "done"))}\n${t(run, "maxStepsSuffix")}`,
      toolResults,
      pendingActions,
      workspacePatch: mergeWorkspacePatch(toolResults),
      criticReview,
    };
  }

  private async executePlan(run: RunState, plan: PlanStep[]): Promise<ExecutedPlan> {
    const toolResults: ToolResult[] = [];
    const pendingActions: PendingAction[] = [];
    const executions: ToolExecutionRecord[] = [];
    for (const step of plan) {
      if (!step.toolName) continue;
      const result = await this.executeToolOrCreatePendingAction(run, step);
      toolResults.push(result.result);
      executions.push({ step, result: result.result });
      this.addObservation(run, step, result.result);
      if (result.pendingAction) pendingActions.push(result.pendingAction);
      if (result.result.status === "needs_input" || result.result.status === "failed") break;
    }
    return { toolResults, pendingActions, executions };
  }

  private createCriticGate(run: RunState): CriticGate {
    return new CriticGate({
      critic: this.agents.critic,
      messageBus: run.messageBus,
      trace: run.trace,
      executeCriticPlan: async (criticPlan) => {
        const validPlan = this.validatePlan(criticPlan, this.agents.critic);
        return (await this.executePlan(run, validPlan)).executions;
      },
    });
  }

  private async executeToolOrCreatePendingAction(
    run: RunState,
    step: PlanStep,
  ): Promise<{ result: ToolResult; pendingAction?: PendingAction }> {
    const tool = this.tools.get(step.toolName ?? "");
    if (!tool) throw new AgentError("TOOL_NOT_FOUND", "Planned tool is not registered.", { statusCode: 404 });

    const hydratedArgs = this.contextHydrator.hydrate(tool.name, (step.arguments ?? {}) as Record<string, unknown>, run.context, run.workspace);
    run.trace.add({
      agentName: step.agentName,
      type: "reason",
      summary: `Hydrated arguments for ${tool.name}.`,
      toolName: tool.name,
      status: "success",
      completedAt: new Date().toISOString(),
      metadata: { argumentKeys: Object.keys(hydratedArgs) },
    });
    if (Array.isArray(hydratedArgs.__resolverConflicts) && hydratedArgs.__resolverConflicts.length > 0) {
      run.trace.add({
        agentName: step.agentName,
        type: "reason",
        summary: `Resolver detected conflicting IDs for ${tool.name}.`,
        toolName: tool.name,
        status: "needs_input",
        completedAt: new Date().toISOString(),
        metadata: {
          toolName: tool.name,
          conflicts: hydratedArgs.__resolverConflicts,
        },
      });
    }
    const idGuardResult = guardToolIds(tool.name, hydratedArgs);
    if (idGuardResult) {
      run.trace.add({
        agentName: step.agentName,
        type: "reason",
        summary: `Guard blocked tool ${tool.name}: non-canonical ID detected.`,
        toolName: tool.name,
        status: "needs_input",
        completedAt: new Date().toISOString(),
        metadata: {
          stepId: step.id,
          toolName: tool.name,
          rejectedReason: idGuardResult.actionResult?.missingInputs,
          sessionId: run.context.sessionId,
          turnId: run.context.turnId,
        },
      });
      this.emit(run, "agent.tool.failed", `工具调用被拦截：${tool.name}`, {
        agentName: step.agentName,
        toolName: tool.name,
        status: "needs_input",
        payload: { reason: "non_canonical_id", missingInputs: idGuardResult.actionResult?.missingInputs },
      });
      return { result: idGuardResult };
    }
    const parsed = tool.inputSchema.safeParse(stripInternalToolArgs(hydratedArgs));
    if (!parsed.success) {
      const missingFields = parsed.error.issues
        .map((issue) => issue.path.join("."))
        .filter(Boolean);
      this.emit(run, "agent.tool.failed", `工具调用失败：${tool.name}`, {
        agentName: step.agentName,
        toolName: tool.name,
        status: "needs_input",
        payload: { reason: "missing_required_input" },
      });
      const message = toolNeedsInputMessageForFields(tool.name, missingFields, localeFor(run));
      return {
        result: {
          status: "needs_input",
          message,
          visibility: "error_user_visible",
          actionResult: {
            actionType: tool.name,
            status: "needs_input",
            reason: "missing_required_input",
            missingInputs: missingFields,
            message,
          },
        },
      };
    }
    const args = parsed.data as Record<string, unknown>;
    const scopedArgs = {
      ...args,
      ...(Array.isArray(hydratedArgs.__resolverConflicts) ? { __resolverConflicts: hydratedArgs.__resolverConflicts } : {}),
    };
    const scopeGuardResult = await guardToolScope(tool.name, scopedArgs, run.context, run.workspace);
    if (scopeGuardResult) {
      run.trace.add({
        agentName: step.agentName,
        type: "reason",
        summary: `Guard blocked tool ${tool.name}: scope validation failed.`,
        toolName: tool.name,
        status: "needs_input",
        completedAt: new Date().toISOString(),
        metadata: {
          stepId: step.id,
          toolName: tool.name,
          reason: scopeGuardResult.actionResult?.missingInputs,
          sessionId: run.context.sessionId,
          turnId: run.context.turnId,
        },
      });
      this.emit(run, "agent.tool.failed", `工具调用被拦截：${tool.name}`, {
        agentName: step.agentName,
        toolName: tool.name,
        status: "needs_input",
        payload: { reason: "scope_guard", missingInputs: scopeGuardResult.actionResult?.missingInputs },
      });
      return { result: scopeGuardResult };
    }
    this.emit(run, "agent.tool.started", labelForToolStarted(tool.name), {
      agentName: step.agentName,
      toolName: tool.name,
      status: "running",
    });
    if (!tool.requiresConfirmation) {
      try {
        const rawResult = await run.executor.executeDefinition(tool, args, run.context);
        const patched = sanitizeReadToolConfirmationResult(rawResult, tool.name);
        if (patched !== rawResult) {
          run.trace.add({
            agentName: "AgentOrchestrator",
            type: "reason",
            summary: `Downgraded unexpected needs_confirmation from read tool ${tool.name} to success.`,
            status: "success",
            completedAt: new Date().toISOString(),
          });
        }
        const result = ensureToolResultVisibility(patched, tool.name);
        this.emit(run, "agent.tool.completed", "工具调用完成", {
          agentName: step.agentName,
          toolName: tool.name,
          status: result.status,
        });
        return { result };
      } catch (error) {
        this.emit(run, "agent.tool.failed", `工具调用失败：${tool.name}`, {
          agentName: step.agentName,
          toolName: tool.name,
          status: "failed",
          payload: { message: error instanceof Error ? error.message : "Tool execution failed." },
        });
        throw error;
      }
    }

    const pending = await this.pendingActions.create({
      userId: run.context.userId,
      sessionId: run.context.sessionId,
      turnId: run.context.turnId,
      tool,
      toolArguments: args,
      title: step.summary,
      summary: confirmationSummary(tool.name, localeFor(run)),
      affectedResources: affectedResourcesFor(tool.name, args),
      preview: previewFor(tool.name, args),
    });
    run.trace.add({
      agentName: step.agentName,
      type: "confirmation_required",
      summary: `Confirmation required for ${tool.name}.`,
      toolName: tool.name,
      status: "needs_input",
      completedAt: new Date().toISOString(),
      metadata: { pendingActionId: pending.id },
    });
    this.emit(run, "agent.pending_action.created", "已准备确认操作", {
      agentName: step.agentName,
      toolName: tool.name,
      status: "needs_confirmation",
      payload: {
        pendingActionId: pending.id,
        toolName: tool.name,
        summary: pending.summary,
        riskLevel: pending.riskLevel,
      },
    });
    this.emit(run, "agent.tool.completed", "已准备确认操作", {
      agentName: step.agentName,
      toolName: tool.name,
      status: "needs_confirmation",
      payload: { pendingActionId: pending.id },
    });
    return {
      pendingAction: pending,
      result: {
        status: "needs_input",
        message: pending.summary,
        pendingActionId: pending.id,
        visibility: "action_required",
        actionResult: {
          status: "needs_confirmation",
          actionType: tool.name,
          pendingActionId: pending.id,
        },
      },
    };
  }

  private validatePlan(plan: PlanStep[], agent: Agent): PlanStep[] {
    return plan.map((step) => {
      if (step.agentName !== agent.name) {
        throw new AgentError("INVALID_AGENT_OUTPUT", "Plan step agent mismatch.", { statusCode: 502 });
      }
      if (step.toolName && !agent.allowedTools.includes(step.toolName)) {
        throw new AgentError("TOOL_NOT_FOUND", "Tool is not allowed for this agent.", { statusCode: 403 });
      }
      return step;
    });
  }

  private addObservation(run: RunState, step: PlanStep, result: ToolResult): void {
    const observation: AgentObservation = {
      id: `obs-${randomUUID()}`,
      stepId: step.id,
      agentName: step.agentName,
      toolName: step.toolName,
      status: observationStatus(result),
      message: result.message,
      data: result.data,
      createdAt: new Date().toISOString(),
    };
    run.context.observations = [...(run.context.observations ?? []), observation];
    run.loopController.state.observations = run.context.observations;
    run.context.loopState = run.loopController.state;
    run.messageBus.add({
      from: "orchestrator",
      to: step.agentName,
      type: "observation",
      content: result.message ?? `${step.toolName ?? "tool"} completed with ${result.status}.`,
      payload: {
        observationId: observation.id,
        stepId: step.id,
        toolName: step.toolName,
        status: observation.status,
      },
    });
    run.context.agentMessages = run.messageBus.list();
  }

  private syncLoopState(run: RunState): void {
    run.loopController.state.observations = run.context.observations ?? [];
    run.context.loopState = run.loopController.state;
    run.context.agentMessages = run.messageBus.list();
  }

  private mapExplicitAction(
    request: CopilotActionRequest,
    run: RunState,
  ): { kind: "step"; step: PlanStep } | { kind: "needs_input"; missingInputs: string[]; message: string } | { kind: "unsupported" } {
    const payload = request.action.payload ?? {};
    const clientState = request.clientState ?? {};
    const workspace = run.workspace;
    const ctx = run.context.activeAssetContext;
    const jdDraft = mostRecentJDDraft(workspace);

    // Resolve IDs using fallback chain: payload -> action.variantId -> clientState -> activeAssetContext -> workspace
    const resolve = {
      experienceId: () =>
        stringValue(payload.experienceId) ?? clientState.activeExperienceId ?? workspace?.active?.experienceId ?? ctx?.activeExperience?.id,
      resumeItemId: () =>
        stringValue(payload.resumeItemId) ?? clientState.activeResumeItemId ?? ctx?.activeResume?.selectedItem?.id,
      resumeId: () =>
        stringValue(payload.resumeId) ?? clientState.activeResumeId ?? workspace?.resumeId ?? workspace?.activeResume?.id ?? ctx?.activeResume?.id,
      jdId: () =>
        stringValue(payload.jdId) ?? clientState.activeJDId ?? workspace?.active?.jdId ?? workspace?.jdId ?? ctx?.activeJD?.id,
      jdText: () =>
        stringValue(payload.jdText) ?? stringValue(payload.text) ?? jdDraft?.rawText ?? ctx?.activeJD?.rawTextPreview ?? clientState.selectedText,
      variantId: () =>
        stringValue(payload.variantId) ?? request.action.variantId ?? clientState.activeVariantId ?? workspace?.activeVariantId ?? ctx?.activeVariant?.id,
      generationId: () =>
        stringValue(payload.generationId) ?? workspace?.productGenerationId,
      evidenceId: () =>
        stringValue(payload.evidenceId) ?? clientState.activeEvidenceId,
      content: () =>
        stringValue(payload.content) ?? stringValue(payload.rewrittenText) ?? stringValue(payload.after),
      selectedText: () =>
        stringValue(payload.selectedText) ?? stringValue(payload.instruction) ?? clientState.selectedText ?? ctx?.activeResume?.selectedItem?.contentPreview,
    };

    switch (request.action.type) {
      case "rewrite_experience": {
        const experienceId = resolve.experienceId();
        if (!experienceId) {
          return { kind: "needs_input", missingInputs: ["experienceId"], message: "请先选择一条经历，或打开经历详情后再让我改写。" };
        }
        const content = resolve.content();
        if (!content) {
          return { kind: "needs_input", missingInputs: ["content"], message: "我已找到这条经历，但还没有生成改写后的正文。请先让我生成改写版本。" };
        }
        return { kind: "step", step: explicitStep("experience_receiver", "update_experience", {
          experienceId,
          patch: {},
          content,
        }, "Rewrite experience after confirmation.") };
      }

      case "optimize_resume_item": {
        const resumeItemId = resolve.resumeItemId();
        if (!resumeItemId) {
          return { kind: "needs_input", missingInputs: ["resumeItemId"], message: "请先选择一条简历内容，再让我优化。" };
        }
        const instruction = resolve.selectedText() ?? "优化这段简历内容。";
        return { kind: "step", step: explicitStep("architect", "revise_resume_item", {
          resumeItemId,
          instruction,
        }, "Revise resume item after confirmation.") };
      }

      case "generate_from_jd": {
        const jdId = resolve.jdId();
        const jdText = resolve.jdText();
        if (!jdId && !jdText) {
          return { kind: "needs_input", missingInputs: ["jdId", "jdText"], message: "请先选择或粘贴一段 JD。" };
        }
        return { kind: "step", step: explicitStep("architect", "generate_resume_from_jd", {
          jdId,
          jdText,
          targetRole: stringValue(payload.targetRole),
        }, "Generate resume from JD after confirmation.") };
      }

      case "show_evidence":
      case "explain_choice": {
        const evidenceId = resolve.evidenceId();
        const variantId = resolve.variantId();
        const generationId = resolve.generationId();
        const id = evidenceId ?? variantId ?? generationId;
        if (!id) {
          return { kind: "needs_input", missingInputs: ["evidenceId", "variantId", "generationId"], message: "请先选择一个生成版本或证据项。" };
        }
        return { kind: "step", step: explicitStep("critic", "show_evidence", {
          id,
          variantId,
          generationId,
          evidenceId,
        }, "Show evidence.") };
      }

      case "export_resume": {
        const resumeId = resolve.resumeId();
        if (!resumeId) {
          return { kind: "needs_input", missingInputs: ["resumeId"], message: "请先打开一份简历，再进行导出。" };
        }
        return { kind: "step", step: explicitStep("architect", "export_resume", {
          resumeId,
          format: payload.format ?? "html",
          templateId: stringValue(payload.templateId),
        }, "Export resume after confirmation.") };
      }

      case "accept": {
        const variantId = resolve.variantId();
        if (!variantId) {
          return { kind: "needs_input", missingInputs: ["variantId"], message: "请先选择一个生成版本。" };
        }
        if (!isCanonicalVariantId(variantId)) {
          return { kind: "needs_input", missingInputs: ["variantId"], message: "我需要先确认你指的是哪个版本，请从版本列表中选择。" };
        }
        const generationId = resolve.generationId();
        if (!generationId) {
          return { kind: "needs_input", missingInputs: ["generationId"], message: "请先打开一次生成结果，或重新生成简历版本。" };
        }
        if (!isCanonicalGenerationId(generationId)) {
          return { kind: "needs_input", missingInputs: ["generationId"], message: "我需要先确认你指的是哪次生成结果，请从生成历史中选择。" };
        }
        const resumeId = resolve.resumeId();
        return { kind: "step", step: explicitStep("architect", "accept_generation_variant", {
          generationId,
          variantId,
          resumeId,
        }, "Accept variant after confirmation.") };
      }

      case "reject": {
        const variantId = resolve.variantId();
        if (!variantId) {
          return { kind: "needs_input", missingInputs: ["variantId"], message: "请先选择一个生成版本。" };
        }
        if (!isCanonicalVariantId(variantId)) {
          return { kind: "needs_input", missingInputs: ["variantId"], message: "我需要先确认你指的是哪个版本，请从版本列表中选择。" };
        }
        return { kind: "needs_input", missingInputs: [], message: "已标记该版本为不采用。如需其他版本，请选择后点击接受。" };
      }

      case "prefer": {
        const variantId = resolve.variantId();
        if (!variantId) {
          return { kind: "needs_input", missingInputs: ["variantId"], message: "请先选择一个生成版本。" };
        }
        if (!isCanonicalVariantId(variantId)) {
          return { kind: "needs_input", missingInputs: ["variantId"], message: "我需要先确认你指的是哪个版本，请从版本列表中选择。" };
        }
        return { kind: "needs_input", missingInputs: [], message: "请说明你的偏好方向（例如：更量化、更保守、更简洁），我会据此调整。" };
      }

      case "confirm_metric":
      case "revise_more_conservative":
      case "revise_more_quantified":
        // These are valid action types but not yet fully implemented. Return needs_input with a helpful message.
        return { kind: "needs_input", missingInputs: [], message: "该操作暂未完整实现，请通过对话方式进行操作。" };

      default:
        return { kind: "unsupported" };
    }
  }

  private async finishError(
    userId: string,
    run: RunState,
    error: unknown,
    options?: { skipCompletedEmit?: boolean },
  ): Promise<CopilotChatResponse> {
    const agentError = error instanceof AgentError
      ? error
      : new AgentError("TOOL_EXECUTION_FAILED", "Agent run failed.", { cause: error });
    run.trace.add({
      agentName: "AgentOrchestrator",
      type: "error",
      summary: agentError.code,
      status: "failed",
      completedAt: new Date().toISOString(),
    });
    return this.finishRun(userId, run, {
      assistantText: agentError.toUserMessage(),
      toolResults: [failedActionResult("agent_run", agentError.toUserMessage(), agentError.code)],
      pendingActions: [],
      workspacePatch: {},
    }, options);
  }

  private async finishRun(
    userId: string,
    run: RunState,
    input: {
      assistantText: string;
      toolResults: ToolResult[];
      pendingActions: PendingAction[];
      workspacePatch: Record<string, unknown>;
      criticReview?: CriticReview;
    },
    options?: { skipCompletedEmit?: boolean },
  ): Promise<CopilotChatResponse> {
    const sanitized = sanitizeInvalidConfirmationResults(run, input.toolResults);
    if (sanitized.invalidCount > 0) {
      run.trace.add({
        agentName: "AgentOrchestrator",
        type: "reason",
        summary: "invalid_needs_confirmation_without_pending_action_id",
        status: "failed",
        completedAt: new Date().toISOString(),
        metadata: { invalidCount: sanitized.invalidCount },
      });
    }
    run.trace.add({
      agentName: "AgentOrchestrator",
      type: "final",
      summary: "Prepared user-visible response.",
      status: "success",
      completedAt: new Date().toISOString(),
    });
    this.emit(run, "agent.thinking", "正在整理最终回复…", {
      agentName: "AgentOrchestrator",
      status: "running",
    });
    const now = new Date().toISOString();
    const composed = this.responseComposer.compose({
      locale: localeFor(run),
      userMessage: run.context.userMessage,
      frontDeskHandoff: run.context.productContext.frontDeskHandoff as FrontDeskHandoff | undefined,
      workspace: run.workspace,
      toolResults: sanitized.toolResults,
      pendingActions: input.pendingActions,
      criticReview: input.criticReview,
      currentTask: run.workspace?.currentTask,
      suggestedTasks: run.workspace?.suggestedTasks,
      context: run.context,
      fallbackText: input.assistantText,
    });
    const assistantText = sanitized.invalidCount > 0 ? t(run, "invalidConfirmation") : composed.assistantText;
    const workspacePatch = sanitized.invalidCount > 0 ? {} : input.workspacePatch;
    const assistantMessage = await this.saveMessage(userId, run.context.sessionId, "assistant", assistantText, run.context.turnId, sanitized.toolResults);
    this.emit(run, "agent.message.completed", "回复已生成", {
      agentName: "AgentOrchestrator",
      status: "success",
      payload: { messageId: assistantMessage.id },
    });
    const workspace = await this.saveWorkspace(userId, run.context.sessionId, run.workspace, workspacePatch, now);
    this.emit(run, "agent.workspace.updated", "工作区已更新", {
      agentName: "AgentOrchestrator",
      status: "success",
      payload: {
        workspaceId: workspace.id,
        status: workspace.status,
        variantCount: workspace.variants.length,
      },
    });
    await this.deps.kernel.copilotServices.sessionService.completeTurn(userId, run.context.turnId, assistantMessage.id);
    await this.deps.kernel.copilotServices.workspaceService.recordActivity(userId, {
      sessionId: run.context.sessionId,
      type: "chat",
      title: "Copilot replied",
      metadata: { traceRunId: run.trace.trace.runId },
    });
    const response: CopilotChatResponse = {
      sessionId: run.context.sessionId,
      turnId: run.context.turnId,
      assistantMessage,
      timeline: timelineFor(sanitized.toolResults, now, run.context.turnId),
      workspace,
      nextActions: composed.nextActions ?? [],
      raw: {
        artifactIds: [],
        evidenceChainIds: [],
        critiqueItemIds: [],
        decisionIds: [],
        agentTrace: run.trace.trace,
        toolResults: sanitized.toolResults,
        pendingActions: input.pendingActions,
        metadata: {
          loop: run.context.loopState,
          observations: run.context.observations ?? [],
          agentMessages: run.context.agentMessages ?? [],
          criticReview: input.criticReview,
          responseComposer: {
            used: true,
            systemNotices: composed.systemNotices,
          },
        },
        actionResults: sanitized.toolResults
          .map((result) => result.actionResult)
          .filter((item): item is CopilotActionResult => item !== undefined && typeof item.status === "string"),
      },
    };
    if (!options?.skipCompletedEmit) {
      this.emit(run, "agent.completed", "处理完成", {
        agentName: "AgentOrchestrator",
        status: "success",
        response,
        payload: { response },
      });
    }
    return response;
  }

  private async saveMessage(
    userId: string,
    sessionId: string,
    role: "user" | "assistant",
    content: string,
    turnId?: string,
    toolResults: ToolResult[] = [],
  ): Promise<CopilotMessage> {
    const message: CopilotMessage = {
      id: `msg-${randomUUID()}`,
      sessionId,
      turnId,
      role,
      content,
      kind: role === "assistant" && toolResults.some((result) => result.actionResult?.status === "needs_confirmation")
        ? "clarifying_question"
        : "plain_text",
      createdAt: new Date().toISOString(),
    };
    return this.deps.kernel.copilotServices.sessionService.saveMessage(userId, message);
  }

  private async saveWorkspace(
    userId: string,
    sessionId: string,
    existing: CopilotWorkspace | null,
    patch: Record<string, unknown>,
    now: string,
  ): Promise<CopilotWorkspace> {
    const workspace: CopilotWorkspace = {
      id: existing?.id ?? `ws-${sessionId}`,
      sessionId,
      variants: existing?.variants ?? [],
      status: existing?.status ?? "empty",
      updatedAt: now,
      ...existing,
      ...patch,
      active: {
        ...(existing?.active ?? {}),
        ...(isRecord(patch.active) ? patch.active : {}),
      },
    } as CopilotWorkspace;
    return this.deps.kernel.copilotServices.workspaceService.saveWorkspace(userId, workspace);
  }
}

function explicitStep(agentName: AgentName, toolName: string, args: Record<string, unknown>, summary: string): PlanStep {
  return {
    id: `step-${randomUUID()}`,
    agentName,
    toolName,
    arguments: args,
    summary,
  };
}

function labelForAgentStarted(agentName: AgentName): string {
  if (agentName === "experience_receiver") return "正在整理经历…";
  if (agentName === "strategist") return "正在分析岗位需求…";
  if (agentName === "architect") return "正在处理简历…";
  if (agentName === "critic") return "正在审查生成结果…";
  return "正在思考…";
}

function labelForCriticStatus(status: string): string {
  if (status === "pass" || status === "skipped") return "审查通过";
  if (status === "needs_revision") return "需要修改后使用";
  if (status === "needs_user_confirmation") return "需要用户确认";
  if (status === "blocked") return "结果已拦截";
  return "审查完成";
}

function labelForToolStarted(toolName: string): string {
  if (toolName === "list_experiences" || toolName === "search_experiences" || toolName === "get_experience") {
    return "正在查看经历库…";
  }
  return `正在调用工具：${toolName}`;
}

type RuntimeTextKey =
  | "productIntro"
  | "clarify"
  | "unknownRequest"
  | "unsupportedAction"
  | "confirmFacts"
  | "confirmedExecuted"
  | "done"
  | "needSpecificAction"
  | "criticBlocked"
  | "confirmHighRisk"
  | "maxStepsSuffix"
  | "missingRequired"
  | "missingInput"
  | "missingRequiredWithFields"
  | "missingFields"
  | "invalidConfirmation";

const RUNTIME_TEXT: Record<CopilotLocale, Record<RuntimeTextKey, string>> = {
  "zh-CN": {
    productIntro: "我是你的求职经历 Copilot，可以帮你整理经历、分析 JD、生成和修改简历。有什么我可以帮你的？",
    clarify: "请再补充一点信息，我好继续处理。",
    unknownRequest: "我还不确定该如何处理这个请求，请换一种说法再描述一次。",
    unsupportedAction: "暂不支持这个 Copilot 操作。",
    confirmFacts: "请先确认具体事实和指标后，我再继续处理。",
    confirmedExecuted: "已确认并执行。",
    done: "已完成。",
    needSpecificAction: "我理解了你的请求，但还需要更具体的操作才能继续。",
    criticBlocked: "生成结果需要先审查，暂时不能直接使用。",
    confirmHighRisk: "这次变更风险较高，请先确认后再继续。",
    maxStepsSuffix: "我已完成当前可用的运行步骤。如需继续，请告诉我下一步要调整什么。",
    missingRequired: "这个操作缺少必填信息。",
    missingInput: "缺少必填输入。",
    missingRequiredWithFields: "这个操作缺少必填信息：{fields}。",
    missingFields: "缺少：{fields}",
    invalidConfirmation: "确认操作缺少确认 ID，请重新发起或稍后重试。",
  },
  en: {
    productIntro: "I am your resume Copilot. I can help organize experiences, analyze JDs, and generate or revise resumes. What would you like to do?",
    clarify: "Please provide a little more detail so I can continue.",
    unknownRequest: "I am not sure how to handle this request. Please describe it again.",
    unsupportedAction: "Unsupported copilot action.",
    confirmFacts: "Please confirm the specific facts and metrics before I continue.",
    confirmedExecuted: "Confirmed and executed.",
    done: "Done.",
    needSpecificAction: "I understand the request, but need a more specific action before I can continue.",
    criticBlocked: "The generated result needs review before it can be used.",
    confirmHighRisk: "Please confirm before I continue with this higher-risk change.",
    maxStepsSuffix: "I completed the available runtime steps. Tell me what you want to adjust next if we should continue.",
    missingRequired: "This action is missing required information.",
    missingInput: "Missing required input.",
    missingRequiredWithFields: "This action is missing required information: {fields}.",
    missingFields: "Missing: {fields}",
    invalidConfirmation: "The confirmation action is missing a confirmation ID. Please start it again or retry later.",
  },
};

function localeFor(run: RunState): CopilotLocale {
  return detectLocale(run.context.userMessage, run.context.clientState);
}

function t(run: RunState, key: RuntimeTextKey): string {
  return text(localeFor(run), key);
}

function text(locale: CopilotLocale, key: RuntimeTextKey): string {
  return RUNTIME_TEXT[locale][key];
}

function formatText(locale: CopilotLocale, key: RuntimeTextKey, values: Record<string, string>): string {
  return Object.entries(values).reduce((message, [name, value]) => message.replace(`{${name}}`, value), text(locale, key));
}

function sanitizeInvalidConfirmationResults(run: RunState, results: ToolResult[]): { toolResults: ToolResult[]; invalidCount: number } {
  let invalidCount = 0;
  const toolResults = results.map((result) => {
    if (result.actionResult?.status !== "needs_confirmation") return result;
    const pendingActionId = stringValue(result.actionResult.pendingActionId) ?? stringValue(result.pendingActionId);
    if (pendingActionId) {
      return {
        ...result,
        pendingActionId,
        actionResult: { ...result.actionResult, pendingActionId },
      };
    }
    invalidCount += 1;
    const message = t(run, "invalidConfirmation");
    return {
      ...result,
      status: "needs_input" as const,
      message,
      pendingActionId: undefined,
      actionResult: {
        actionType: typeof result.actionResult.actionType === "string" ? result.actionResult.actionType : "unknown",
        status: "needs_input",
        reason: "invalid_needs_confirmation_without_pending_action_id",
        message,
      },
    };
  });
  return { toolResults, invalidCount };
}

function shouldEmitCriticReview(executions: ToolExecutionRecord[]): boolean {
  return executions.some((execution) => execution.result.status === "success" && Boolean(execution.step.toolName && shouldReviewTool(execution.step.toolName)));
}

function confirmedActionStep(action: PendingAction, agentName: AgentName): PlanStep {
  return {
    id: `confirm-${action.id}`,
    agentName,
    toolName: action.toolName,
    arguments: summarizePendingArguments(action.toolArguments),
    summary: `Confirmed pending action ${action.toolName}`,
  };
}

function summarizePendingArguments(args: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(args);
  return {
    argumentKeys: keys.slice(0, 12),
    argumentCount: keys.length,
  };
}

function failedActionResult(actionType: string, message: string, reason = "unsupported_action"): ToolResult {
  return {
    status: "failed",
    message,
    visibility: "error_user_visible",
    actionResult: { actionType, status: "failed", message, reason },
  };
}

function needsConfirmationResult(message: string): ToolResult {
  return {
    status: "needs_input",
    message,
    visibility: "action_required",
    actionResult: { actionType: "critic_gate", status: "needs_input", message, reason: "critic_needs_user_confirmation" },
  };
}

function needsRevisionResult(message: string): ToolResult {
  return {
    status: "needs_input",
    message,
    visibility: "action_required",
    actionResult: { actionType: "critic_gate", status: "needs_input", message, reason: "critic_needs_revision" },
  };
}

function criticRevisionMessage(review: CriticReview | undefined, locale: CopilotLocale): string {
  const summary = review?.userVisibleSummary || (locale === "zh-CN" ? "结果需要修改后才能使用。" : "The result needs revision before it can be used.");
  const fixes = review?.suggestedFixes?.filter(Boolean) ?? [];
  if (fixes.length === 0) return summary;
  const label = locale === "zh-CN" ? "建议修改：" : "Suggested fixes:";
  return `${summary}\n${label}\n${fixes.map((fix) => `- ${fix}`).join("\n")}`;
}

function observationStatus(result: ToolResult): AgentObservationStatus {
  if (result.actionResult?.status === "needs_confirmation") return "needs_confirmation";
  if (result.status === "needs_input") return "needs_input";
  return result.status;
}

function firstStopStatus(results: ToolResult[]): "needs_input" | "needs_confirmation" | "failed" | undefined {
  for (const result of results) {
    const status = observationStatus(result);
    if (status === "needs_confirmation" || status === "needs_input" || status === "failed") return status;
  }
  return undefined;
}

function decisionTraceMeta(decision: unknown): Record<string, unknown> | undefined {
  const meta = getAgentDecisionMeta(decision);
  if (!meta) return undefined;
  return {
    decisionSource: meta.decisionSource,
    fallbackReason: meta.fallbackReason,
    modelUsed: meta.modelUsed,
    schemaValid: meta.schemaValid,
    repairApplied: meta.repairApplied,
  };
}

function mergeWorkspacePatch(results: ToolResult[]): Record<string, unknown> {
  return results
    .filter((result) => result.status === "success")
    .reduce<Record<string, unknown>>((merged, result) => ({ ...merged, ...(result.workspacePatch ?? {}) }), {});
}

function ensureToolResultVisibility(result: ToolResult, toolName?: string): ToolResult {
  return {
    ...result,
    visibility: result.visibility ?? defaultToolResultVisibility(toolName, result.status),
  };
}

export function sanitizeReadToolConfirmationResult(result: ToolResult, toolName: string): ToolResult {
  if (result.actionResult?.status !== "needs_confirmation") return result;
  return {
    ...result,
    visibility: result.visibility ?? "user_summary",
    actionResult: {
      ...(result.actionResult as Record<string, unknown>),
      status: "success",
      reason: "read_tool_cannot_request_confirmation",
    },
  };
}

function assistantFromResults(results: ToolResult[], fallback: string): string {
  const visible = results
    .filter((result) => result.visibility === "user_summary" || result.visibility === "action_required" || result.visibility === "error_user_visible")
    .map((result) => result.message)
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0 && !isBlockedToolLog(item));
  if (visible.length > 0) return visible.join("\n");
  return fallback;
}

function timelineFor(results: ToolResult[], now: string, turnId: string): ProductTimelineItem[] {
  if (results.length === 0) {
    return [{ id: `tl-${turnId}-message`, type: "message_received", title: "Assistant replied", status: "completed", createdAt: now }];
  }
  return results.map((result, index) => ({
    id: `tl-${turnId}-${index}`,
    type: result.actionResult?.status === "needs_confirmation" ? "warning" : "message_received",
    title: result.message ?? "Tool result",
    status: result.status === "failed" ? "failed" : "completed",
    createdAt: now,
  }));
}

function confirmationSummary(toolName: string, locale: CopilotLocale): string {
  if (locale === "zh-CN") {
    if (toolName === "save_experience_from_text") return "已准备好一条经历草稿，请确认后写入经历库。";
    if (toolName === "update_experience") return "请确认是否更新这段经历。";
    if (toolName === "delete_experience") return "请确认是否删除这段经历。";
    if (toolName === "export_resume") return "请确认是否创建这份简历导出。";
    if (toolName === "accept_generation_variant") return "请确认是否将此版本保存到简历库。";
    return `请确认是否执行 ${toolName}。`;
  }
  if (toolName === "save_experience_from_text") return "Please confirm saving this experience to your library.";
  if (toolName === "update_experience") return "Please confirm updating this experience.";
  if (toolName === "delete_experience") return "Please confirm deleting this experience.";
  if (toolName === "export_resume") return "Please confirm creating this resume export.";
  if (toolName === "accept_generation_variant") return "Please confirm saving this variant to your resume.";
  return `Please confirm ${toolName}.`;
}

function legacyGuardToolIds(toolName: string, args: Record<string, unknown>): ToolResult | undefined {
  // Experience tools: args.experienceId / args.id must be canonical experience id
  if (["get_experience", "update_experience", "prepare_update_experience", "delete_experience", "prepare_delete_experience"].includes(toolName)) {
    const id = stringValue(args.experienceId) ?? stringValue(args.id);
    if (id && !isCanonicalExperienceId(id)) {
      return {
        status: "needs_input",
        message: "我需要先确认你指的是哪条经历，请从经历库中选择，或让我先搜索相关经历。",
        visibility: "error_user_visible",
        actionResult: {
          actionType: toolName,
          status: "needs_input",
          missingInputs: ["experienceId"],
          message: "我需要先确认你指的是哪条经历，请从经历库中选择，或让我先搜索相关经历。",
        },
      };
    }
  }

  // JD tools: jdId must be canonical JD id
  if (["get_jd"].includes(toolName)) {
    const jdId = stringValue(args.jdId) ?? stringValue(args.id);
    if (jdId && !isCanonicalJDId(jdId)) {
      return {
        status: "needs_input",
        message: "我需要先确认你指的是哪份 JD，请从 JD 库中选择，或让我先搜索相关 JD。",
        visibility: "error_user_visible",
        actionResult: {
          actionType: toolName,
          status: "needs_input",
          missingInputs: ["jdId"],
          message: "我需要先确认你指的是哪份 JD，请从 JD 库中选择，或让我先搜索相关 JD。",
        },
      };
    }
  }

  // Resume tools: resumeId must be canonical resume id
  if (["get_resume", "export_resume"].includes(toolName)) {
    const resumeId = stringValue(args.resumeId) ?? stringValue(args.id);
    if (resumeId && !isCanonicalResumeId(resumeId)) {
      return {
        status: "needs_input",
        message: "我需要先确认你指的是哪份简历，请从简历库中选择。",
        visibility: "error_user_visible",
        actionResult: {
          actionType: toolName,
          status: "needs_input",
          missingInputs: ["resumeId"],
          message: "我需要先确认你指的是哪份简历，请从简历库中选择。",
        },
      };
    }
  }

  // accept_generation_variant: generationId must be canonical; variantId must be canonical; resumeId (if present) must be canonical
  if (toolName === "accept_generation_variant") {
    const generationId = stringValue(args.generationId);
    if (generationId && !isCanonicalGenerationId(generationId)) {
      return {
        status: "needs_input",
        message: "我需要先确认你指的是哪次生成结果，请从生成历史中选择。",
        visibility: "error_user_visible",
        actionResult: {
          actionType: toolName,
          status: "needs_input",
          missingInputs: ["generationId"],
          message: "我需要先确认你指的是哪次生成结果，请从生成历史中选择。",
        },
      };
    }
    const resumeId = stringValue(args.resumeId);
    if (resumeId && !isCanonicalResumeId(resumeId)) {
      return {
        status: "needs_input",
        message: "我需要先确认你指的是哪份简历，请从简历库中选择。",
        visibility: "error_user_visible",
        actionResult: {
          actionType: toolName,
          status: "needs_input",
          missingInputs: ["resumeId"],
          message: "我需要先确认你指的是哪份简历，请从简历库中选择。",
        },
      };
    }
    const variantId = stringValue(args.variantId);
    if (variantId && !isCanonicalVariantId(variantId)) {
      return {
        status: "needs_input",
        message: "我需要先确认你指的是哪个版本，请从版本列表中选择。",
        visibility: "error_user_visible",
        actionResult: {
          actionType: toolName,
          status: "needs_input",
          missingInputs: ["variantId"],
          message: "我需要先确认你指的是哪个版本，请从版本列表中选择。",
        },
      };
    }
  }

  // show_evidence: id/variantId/evidenceId must be canonical
  if (toolName === "show_evidence") {
    const id = stringValue(args.id);
    if (id && !isCanonicalVariantId(id) && !isCanonicalExperienceId(id)) {
      return {
        status: "needs_input",
        message: "我需要先确认你指的是哪个版本或证据项，请从版本列表中选择。",
        visibility: "error_user_visible",
        actionResult: {
          actionType: toolName,
          status: "needs_input",
          missingInputs: ["id"],
          message: "我需要先确认你指的是哪个版本或证据项，请从版本列表中选择。",
        },
      };
    }
    const variantId = stringValue(args.variantId);
    if (variantId && !isCanonicalVariantId(variantId)) {
      return {
        status: "needs_input",
        message: "我需要先确认你指的是哪个版本，请从版本列表中选择。",
        visibility: "error_user_visible",
        actionResult: {
          actionType: toolName,
          status: "needs_input",
          missingInputs: ["variantId"],
          message: "我需要先确认你指的是哪个版本，请从版本列表中选择。",
        },
      };
    }
    const evidenceId = stringValue(args.evidenceId);
    if (evidenceId && !isCanonicalExperienceId(evidenceId)) {
      return {
        status: "needs_input",
        message: "我需要先确认你指的是哪条证据，请从证据列表中选择。",
        visibility: "error_user_visible",
        actionResult: {
          actionType: toolName,
          status: "needs_input",
          missingInputs: ["evidenceId"],
          message: "我需要先确认你指的是哪条证据，请从证据列表中选择。",
        },
      };
    }
  }

  return undefined;
}

function legacyAffectedResourcesFor(toolName: string, args: Record<string, unknown>) {
  if (toolName.includes("experience")) {
    const rawId = stringValue(args.experienceId) ?? stringValue(args.id);
    const id = isCanonicalExperienceId(rawId) ? rawId : undefined;
    return id ? [{ type: "experience" as const, id }] : [];
  }
  if (toolName.includes("jd")) {
    const rawId = stringValue(args.jdId) ?? stringValue(args.id);
    const id = isCanonicalJDId(rawId) ? rawId : undefined;
    return id ? [{ type: "jd" as const, id }] : [];
  }
  if (toolName.includes("resume")) {
    const rawId = stringValue(args.resumeId) ?? stringValue(args.id);
    const id = isCanonicalResumeId(rawId) ? rawId : undefined;
    return id ? [{ type: "resume" as const, id }] : [];
  }
  if (toolName.includes("export")) return [{ type: "export" as const }];
  return [];
}

function previewFor(toolName: string, args: Record<string, unknown>) {
  if (toolName === "save_experience_from_text") return { after: { text: args.text } };
  if (toolName === "update_experience") {
    const patch = sanitizeExperiencePatch(args.patch);
    return { after: { experienceId: args.experienceId, contentPreview: typeof args.content === "string" ? args.content.slice(0, 200) : undefined, patchKeys: Object.keys(patch).slice(0, 10) } };
  }
  if (toolName === "delete_experience") return { before: args };
  if (toolName === "export_resume") return { after: args };
  return undefined;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hydrateNeedsInputMessage(toolName: string, locale: CopilotLocale): string {
  if (locale === "zh-CN") {
    if (toolName === "get_experience" || toolName === "update_experience") {
      return "请先选择一条经历，或打开经历详情后再让我优化。";
    }
    if (toolName === "revise_resume_item") {
      return "请先选择一条简历内容，再让我优化。";
    }
    if (toolName === "generate_resume_from_jd") {
      return "请先选择或粘贴一段 JD。";
    }
    if (toolName === "export_resume" || toolName === "prepare_export_resume") {
      return "请先选择一份简历。";
    }
    if (toolName === "get_jd") {
      return "请先选择或保存一份 JD。";
    }
    if (toolName === "get_resume") {
      return "请先选择或创建一份简历。";
    }
    if (toolName === "show_evidence") {
      return "请先选择一个生成版本或证据项。";
    }
  }
  // English fallback
  if (toolName === "get_experience" || toolName === "update_experience") {
    return "Please select an experience first, or open the experience detail page.";
  }
  if (toolName === "revise_resume_item") {
    return "Please select a resume item first.";
  }
  if (toolName === "generate_resume_from_jd") {
    return "Please select or paste a JD first.";
  }
  if (toolName === "export_resume" || toolName === "prepare_export_resume") {
    return "Please select a resume first.";
  }
  if (toolName === "get_jd") {
    return "Please select or save a JD first.";
  }
  if (toolName === "get_resume") {
    return "Please select or create a resume first.";
  }
  if (toolName === "show_evidence") {
    return "Please select a generation version or evidence item first.";
  }
  return locale === "zh-CN" ? "缺少必填信息，请先选择相关资产。" : "Missing required information. Please select the relevant asset first.";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

