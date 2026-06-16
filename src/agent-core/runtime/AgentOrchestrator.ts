import { randomUUID } from "node:crypto";
import type { ApiKernel } from "../../api/types.js";
import type { ActiveAssetContext } from "../../copilot/ActiveAssetContextBuilder.js";
import { applyHandoffToDrafts } from "../../copilot/context/DraftContext.js";
import { normalizeFrontDeskHandoff } from "../../copilot/handoff/HandoffNormalizer.js";
import type {
  CopilotActionRequest,
  CopilotChatRequest,
  CopilotChatResponse,
  CopilotClientState,
  CopilotMessageAttachment,
  CopilotMessageMetadata,
  CopilotMessage,
  CopilotWorkspace,
  ProductBlock,
} from "../../copilot/types.js";
import { detectLocale, type CopilotLocale } from "../../copilot/locale.js";
import { isBlockedToolLog } from "../../copilot/response/ProductReplyTemplates.js";
import { isCanonicalExperienceId, isCanonicalGenerationId, isCanonicalJDId, isCanonicalResumeId, isCanonicalVariantId } from "../../copilot/context/IdGuards.js";
import { mergeWorkspacePatch, updatePendingStatusInProductBlocks } from "./WorkspaceProjector.js";
import { tasksFromHandoff } from "../../copilot/tasks/TaskStateReducer.js";
import { createAgentTools } from "../../agent-tools/index.js";
import type { PendingAction } from "../confirmation/PendingAction.js";
import { PendingActionService } from "../confirmation/PendingActionService.js";
import type { Agent } from "../agents/BaseAgent.js";
import type { AgentDomainModule } from "../domain/AgentDomainModule.js";
import { AgentDomainRegistry } from "../domain/AgentDomainRegistry.js";
import { ReviewPolicy } from "../evaluation/ReviewPolicy.js";
import { careerDomain } from "../../agent-domains/career/index.js";
import { PromptRegistry } from "../prompts/PromptRegistry.js";
import { AgentCapabilityRegistry } from "../capabilities/AgentCapabilityRegistry.js";
import { createDefaultCapabilities } from "../capabilities/defaultCapabilities.js";
import { ContextAssemblyPipeline } from "../context/ContextAssemblyPipeline.js";
import { ProductFlowRouter } from "../flow/ProductFlowRouter.js";
import { LearningEventRecorder } from "../reflection/LearningEventRecorder.js";
import { LearningEventService } from "../reflection/LearningEventService.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolResult } from "../tools/ToolResult.js";
import type { AgentName, CriticReview, PlanStep } from "../validation/AgentOutputSchemas.js";
import type { KernelRequestContext } from "../../api/context.js";
import type { AgentContext } from "./AgentContext.js";
import { AgentError } from "./AgentError.js";
import type { AgentMessageBus } from "./AgentMessageBus.js";
import type { AgentMessageParticipant, AgentMessageType } from "./AgentMessage.js";
import type { AgentObservation, AgentObservationStatus } from "./AgentObservation.js";
import type { AgentRuntimeEmitter, AgentStreamEventType } from "./AgentStreamEvent.js";
import { CriticGate, type ToolExecutionRecord } from "./CriticGate.js";
import { AgentDecisionRunner } from "./AgentDecisionRunner.js";
import { AgentResultAssembler } from "./AgentResultAssembler.js";
import { NarratorService } from "../../copilot/response/NarratorService.js";
import { PlanExecutionService, ensureToolResultVisibility } from "./PlanExecutionService.js";
import { ReviewPipeline } from "./ReviewPipeline.js";
import type { ExecutedPlan, LoopRunResult } from "./RunResult.js";
import type { AutoRevisionContext, RunState } from "./RunState.js";

export { guardToolIds } from "../security/ToolIdGuard.js";
export { sanitizeReadToolConfirmationResult } from "./PlanExecutionService.js";

/**
 * Maximum number of automatic critic-revision retries inside a single
 * specialist run. Each retry feeds the critic feedback back to the specialist
 * (via revision_request in the message bus) and lets it replan
 * match_experiences_against_jd → generate_resume_from_jd → critic review.
 * Only after this many consecutive needs_revision verdicts does the
 * orchestrator surface critic_needs_revision to the user.
 */
const MAX_REVISION_ATTEMPTS = 3;

export type AgentOrchestratorDeps = {
  kernel: ApiKernel;
  pendingActions?: PendingActionService;
  domains?: readonly AgentDomainModule[];
};

export class AgentOrchestrator {
  public readonly pendingActions: PendingActionService;
  public readonly tools: ToolRegistry;
  private readonly resultAssembler: AgentResultAssembler;
  private readonly capabilityRegistry: AgentCapabilityRegistry;
  private readonly contextAssemblyPipeline: ContextAssemblyPipeline;
  private readonly planExecutionService: PlanExecutionService;
  private readonly learningEventService: LearningEventService;
  private readonly productFlowRouter = new ProductFlowRouter();
  private readonly decisionRunner = new AgentDecisionRunner();
  private readonly reviewPolicy = new ReviewPolicy();
  private readonly agents: Record<AgentName, Agent>;

  public constructor(private readonly deps: AgentOrchestratorDeps) {
    const promptRegistry = new PromptRegistry();
    const narratorPrompt = (() => {
      try { return promptRegistry.get("product.narrator.system"); }
      catch { return undefined; }
    })();
    const narrator = (deps.kernel.frontDeskModelClient && narratorPrompt)
      ? new NarratorService({ modelClient: deps.kernel.frontDeskModelClient, prompt: narratorPrompt })
      : undefined;
    this.resultAssembler = new AgentResultAssembler(undefined, { narrator });
    const domainRegistry = new AgentDomainRegistry(deps.domains ?? [careerDomain]);
    this.pendingActions = deps.pendingActions ?? new PendingActionService();
    this.tools = new ToolRegistry();
    this.tools.registerMany(createAgentTools());
    this.capabilityRegistry = new AgentCapabilityRegistry([
      ...createDefaultCapabilities(),
      ...(deps.kernel.capabilityModules ?? []),
      ...domainRegistry.listCapabilities(),
    ]);
    this.learningEventService = new LearningEventService({
      recorder: new LearningEventRecorder(this.capabilityRegistry.listReflectionSinks()),
      evaluationHooks: this.capabilityRegistry.listEvaluationHooks(),
    });
    this.contextAssemblyPipeline = new ContextAssemblyPipeline({
      kernel: deps.kernel,
      tools: this.tools,
      capabilityRegistry: this.capabilityRegistry,
    });
    this.planExecutionService = new PlanExecutionService({
      tools: this.tools,
      pendingActions: this.pendingActions,
      localeFor,
      toolCompletedMessage: (run, toolName) => formatText(localeFor(run), "toolCompleted", { tool: toolName }),
      emit: (run, type, label, extra) => this.emit(run, type, label, extra),
      addObservation: (run, step, result) => this.addObservation(run, step, result),
      addPublicAgentMessage: (run, message) => this.addPublicAgentMessage(run, message),
      getOrExecutePrepareSaveResult: (run, args) => this.getOrExecutePrepareSaveResult(run, args),
      getPreparedResumeRewriteResult: (run, args) => this.getPreparedResumeRewriteResult(run, args),
      learningEventService: this.learningEventService,
    });
    const modelClient = deps.kernel.frontDeskModelClient;
    this.agents = domainRegistry.createAgents({ modelClient, promptRegistry });
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
    const resumeUploadAttachment = extractResumeUploadAttachment(request.clientState);
    const userMessageMetadata = buildUserMessageMetadata(resumeUploadAttachment);
    const userMessage = await this.saveMessage(ctx.user.id, session.id, "user", request.message, undefined, [], userMessageMetadata);
    const turn = await this.deps.kernel.copilotServices.sessionService.createTurn(ctx.user.id, session.id, userMessage.id);
    const resumeUploadContext = buildResumeUploadProductContext(resumeUploadAttachment);
    const run = await this.buildAgentContext(ctx, {
      sessionId: session.id,
      turnId: turn.id,
      userMessage: request.message,
      request,
      productContext: {
        targetRole: request.targetRole ?? session.targetRole,
        hasJDText: Boolean(request.jdText ?? session.jdText),
        requestJDText: request.jdText ?? session.jdText ?? undefined,
        ...resumeUploadContext,
      },
      streamEmitter,
    });
    await this.learningEventService.recordUserPreferenceText(run.context, request.message);
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
      const frontDeskDecision = await this.decisionRunner.decide({ agent: this.agents.frontdesk, context: run.context });
      if (isResumeFileImportMessage(run.context.userMessage)) {
        frontDeskDecision.responseType = "route";
        frontDeskDecision.routeTo = "experience_receiver";
        frontDeskDecision.missingInputs = extractResumeFileImportRequest(run.context) ? [] : ["fileId"];
        frontDeskDecision.confidence = Math.max(frontDeskDecision.confidence ?? 0, 0.9);
        frontDeskDecision.assistantMessage = frontDeskDecision.assistantMessage
          || (frontDeskDecision.missingInputs.length > 0
            ? "请重新上传简历文件，我需要 fileId 才能解析。"
            : "我来从上传的简历文件中识别可编辑的经历候选。");
      }
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
      this.decisionRunner.completeDecisionTrace({
        trace: run.trace,
        step: frontDeskStep,
        decision: frontDeskDecision,
        metadata: {
          routeTo: frontDeskDecision.routeTo,
          responseType: frontDeskDecision.responseType,
          handoff: normalizedHandoff.handoff,
        },
      });
      this.emit(run, "agent.route.completed", "任务类型判断完成", {
        agentName: "frontdesk",
        status: frontDeskDecision.responseType,
        payload: {
          routeTo: frontDeskDecision.routeTo,
          responseType: frontDeskDecision.responseType,
        },
      });
      if (frontDeskDecision.routeTo) {
        this.addPublicAgentMessage(run, {
          from: "frontdesk",
          type: "response",
          content: formatText(localeFor(run), "routingTo", { agent: agentLabel(frontDeskDecision.routeTo, localeFor(run)) }),
          payload: { eventType: "routing", routeTo: frontDeskDecision.routeTo },
        });
      }
      this.emit(run, "agent.reasoning.snapshot", "已完成任务意图判断", {
        agentName: "frontdesk",
        status: "completed",
        payload: {
          summary: "任务分类与路由已完成",
          routeTo: frontDeskDecision.routeTo,
          responseType: frontDeskDecision.responseType,
        },
      });

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
    const mapped = this.productFlowRouter.mapExplicitAction({
      request,
      workspace: run.workspace,
      activeAssetContext: run.context.activeAssetContext,
    });
    await this.learningEventService.recordExplicitAction(run.context, request.action.type, {
      ...(request.action.payload ?? {}),
      variantId: request.action.variantId
        ?? (request.action.payload && typeof request.action.payload.variantId === "string" ? request.action.payload.variantId : undefined)
        ?? run.workspace?.activeVariantId,
      generationId: request.action.payload && typeof request.action.payload.generationId === "string"
        ? request.action.payload.generationId
        : run.workspace?.productGenerationId,
    });
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
    const confirmStartedAt = Date.now();
    const action = await this.pendingActions.get(ctx.user.id, id);
    if (!action) throw new AgentError("PERMISSION_DENIED", "Pending action not found.", { statusCode: 404 });
    debugConfirm("start", { pendingActionId: id, toolName: action.toolName, sessionId: action.sessionId });
    const session = await this.deps.kernel.copilotServices.sessionService.getSession(ctx.user.id, action.sessionId);
    if (!session) throw new AgentError("PRODUCT_STATE_NOT_FOUND", "Session not found.", { statusCode: 404 });
    const run = await this.buildAgentContext(ctx, {
      sessionId: session.id,
      turnId: action.turnId ?? `ct-${randomUUID()}`,
      userMessage: `[confirm] ${action.toolName}`,
      request: { sessionId: session.id, message: `[confirm] ${action.toolName}` },
      productContext: { pendingActionId: id },
    });
    let confirmed: Awaited<ReturnType<PendingActionService["confirm"]>>;
    try {
      confirmed = await this.pendingActions.confirm({
        userId: ctx.user.id,
        id,
        registry: this.tools,
        executor: run.executor,
        context: run.context,
        workspace: run.workspace,
      });
    } catch (error) {
      const latest = await this.pendingActions.get(ctx.user.id, id);
      if (latest?.status === "cancelled") {
        await this.updatePendingActionDisplayStatus(ctx.user.id, id, "cancelled");
      } else if (latest?.status === "expired") {
        await this.updatePendingActionDisplayStatus(ctx.user.id, id, "expired");
      } else if (latest?.status === "executed") {
        await this.updatePendingActionDisplayStatus(ctx.user.id, id, "executed");
      }
      throw error;
    }
    const confirmedAction = confirmed.action;
    const result = ensureToolResultVisibility(confirmed.result, confirmedAction.toolName);
    debugConfirm("tool_completed", {
      pendingActionId: id,
      toolName: confirmedAction.toolName,
      status: result.status,
      generationId: readGenerationId(result),
      variantCount: readVariantCount(result),
    });
    const tool = this.tools.get(confirmedAction.toolName);
    const step = confirmedActionStep(confirmedAction, tool?.ownerAgent ?? "frontdesk");
    const execution: ToolExecutionRecord = { step, result };
    const confirmSucceeded = result.status === "success";
    await this.learningEventService.recordPendingActionConfirmed(run.context, confirmedAction, result);
    await this.learningEventService.recordToolResult(run.context, step, result);
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

    // Keep history cards deterministic. Generation confirmations only enqueue
    // work here; the worker marks them executed/failed when the job finishes.
    const confirmationDisplayStatus = isGenerationQueuedResult(result) ? "confirmed" : "executed";
    await this.updatePendingActionDisplayStatus(ctx.user.id, id, confirmationDisplayStatus);
    const toolResultsForResponse = [result];
    debugConfirm("finalize_completed", {
      pendingActionId: id,
      generationId: readGenerationId(result),
      variantCount: readVariantCount(result),
      elapsedMs: Date.now() - confirmStartedAt,
    });

    const confirmReviewPipeline = this.createReviewPipeline(run);
    if (confirmReviewPipeline.shouldReviewTool(confirmedAction.toolName) && !isGenerationQueuedResult(result)) {
      // Skip critic gate review for save_experience_from_text confirmations.
      // The critic already reviewed the draft during the planning phase (prepare_save_experience_from_text).
      // Re-reviewing on confirmation would create a confusing UX loop where the experience is
      // already saved but the user sees "needs revision" — which can trigger an infinite cycle of
      // confirm → review → suggestions → rewrite → confirm → review → ...
      const skipCriticForConfirm = confirmedAction.toolName === "save_experience_from_text"
        || confirmedAction.toolName === "save_jd_from_text";
      if (!skipCriticForConfirm) {
        this.emit(run, "agent.critic.started", "正在审查结果…", {
          agentName: "critic",
          status: "running",
        });
        const gateResult = await confirmReviewPipeline.review({
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
            workspacePatch: mergeWorkspacePatch(toolResultsForResponse),
            criticReview,
          });
        }

        if (gateResult.status === "needs_user_confirmation") {
          const message = criticReview?.userVisibleSummary || t(run, "confirmFacts");
          return this.finishRun(ctx.user.id, run, {
            assistantText: message,
            toolResults: [needsConfirmationResult(message)],
            pendingActions: [],
            workspacePatch: mergeWorkspacePatch(toolResultsForResponse),
            criticReview,
          });
        }

        if (gateResult.status === "needs_revision") {
          const revisionAttemptCount = 1;
          this.recordRevisionRequest(run, step.agentName, criticReview, revisionAttemptCount, "Recorded critic revision request for confirmed action.");
          if (confirmedAction.toolName === "generate_resume_from_jd" && revisionAttemptCount < MAX_REVISION_ATTEMPTS) {
            this.addPublicAgentMessage(run, {
              from: "critic",
              type: "critique",
              content: revisionRetryAnnouncement(criticReview, revisionAttemptCount, MAX_REVISION_ATTEMPTS, localeFor(run)),
              payload: {
                eventType: "announcement",
                status: "needs_revision",
                revisionAttempt: revisionAttemptCount,
                maxAttempts: MAX_REVISION_ATTEMPTS,
                suggestedFixes: criticReview?.suggestedFixes,
              },
            });
            run.autoRevisionContext = {
              autoRevisionAuthorized: true,
              toolName: "generate_resume_from_jd",
              sourcePendingActionId: confirmedAction.id,
            };
            const revised = await this.runSpecialistLoop(run, this.agents[step.agentName], step.agentName, {
              initialRevisionAttemptCount: revisionAttemptCount,
            });
            return this.finishRun(ctx.user.id, run, {
              assistantText: revised.assistantText,
              toolResults: [...toolResultsForResponse, ...gateResult.criticToolResults, ...revised.toolResults],
              pendingActions: revised.pendingActions,
              workspacePatch: {
                ...mergeWorkspacePatch(toolResultsForResponse),
                ...revised.workspacePatch,
              },
              criticReview: revised.criticReview ?? criticReview,
            });
          }
          run.loopController.stop("critic_needs_revision");
          this.syncLoopState(run);
          const message = criticRevisionMessage(criticReview, localeFor(run));
          return this.finishRun(ctx.user.id, run, {
            assistantText: message,
            toolResults: [...toolResultsForResponse, ...gateResult.criticToolResults, needsRevisionResult(message, criticReview, {
              attempts: revisionAttemptCount,
              maxAttempts: MAX_REVISION_ATTEMPTS,
            })],
            pendingActions: [],
            workspacePatch: mergeWorkspacePatch(toolResultsForResponse),
            criticReview,
          });
        }

        return this.finishRun(ctx.user.id, run, {
          assistantText: result.message ?? t(run, "confirmedExecuted"),
          toolResults: [...toolResultsForResponse, ...gateResult.criticToolResults],
          pendingActions: [],
          workspacePatch: mergeWorkspacePatch(toolResultsForResponse),
          criticReview,
        });
      }
    }

    const response = await this.finishRun(ctx.user.id, run, {
      assistantText: result.message ?? t(run, "confirmedExecuted"),
      toolResults: toolResultsForResponse,
      pendingActions: [],
      workspacePatch: mergeWorkspacePatch(toolResultsForResponse),
    });
    debugConfirm("completed", {
      pendingActionId: id,
      generationId: response.workspace.productGenerationId,
      variantCount: response.workspace.variants.length,
      resumeId: response.workspace.resumeId,
      exportId: response.workspace.exportRecords?.[0]?.id,
      exportStatus: response.workspace.exportRecords?.[0]?.status,
      elapsedMs: Date.now() - confirmStartedAt,
    });
    return response;
  }

  /**
   * Public entry point for canceling a pending action with display status update.
   */
  public async cancelPendingAction(userId: string, id: string) {
    const action = await this.pendingActions.cancel(userId, id);
    await this.updatePendingActionDisplayStatus(userId, id, "cancelled");
    await this.learningEventService.recordPendingActionCancelled(action);
    return action;
  }

  /**
   * Update the displaySnapshot.pendingActions status in the assistant message
   * that originally created this pending action, so history cards show the
   * correct read-only state after confirm/cancel.
   */
  private async updatePendingActionDisplayStatus(
    userId: string,
    pendingActionId: string,
    newStatus: "confirmed" | "executed" | "cancelled" | "expired" | "failed",
  ): Promise<void> {
    try {
      const action = await this.pendingActions.get(userId, pendingActionId);
      if (!action || !action.turnId) return;

      // Find the assistant message for this turn
      const messages = await this.deps.kernel.copilotServices.sessionService.listMessages(userId, action.sessionId, 50);
      const assistantMsg = messages.find(
        (msg) => msg.role === "assistant" && msg.turnId === action.turnId,
      );
      if (!assistantMsg?.metadata) return;

      const metadata = assistantMsg.metadata;
      const updatedPendingActions = metadata.displaySnapshot?.pendingActions?.map((pa) =>
        pa.id === pendingActionId ? { ...pa, status: newStatus } : pa,
      );
      const updatedMetadataProductBlocks = updatePendingStatusInProductBlocks(metadata.productBlocks, pendingActionId, newStatus);
      const updatedSnapshotProductBlocks = updatePendingStatusInProductBlocks(
        metadata.displaySnapshot?.productBlocks,
        pendingActionId,
        newStatus,
      );

      const updatedMetadata: CopilotMessageMetadata = {
        ...metadata,
        ...(updatedMetadataProductBlocks ? { productBlocks: updatedMetadataProductBlocks as ProductBlock[] } : {}),
        ...(metadata.displaySnapshot || updatedPendingActions || updatedSnapshotProductBlocks
          ? {
            displaySnapshot: {
              ...(metadata.displaySnapshot ?? {}),
              ...(updatedPendingActions ? { pendingActions: updatedPendingActions } : {}),
              ...(updatedSnapshotProductBlocks ? { productBlocks: updatedSnapshotProductBlocks as ProductBlock[] } : {}),
            },
          }
          : {}),
      };
      await this.deps.kernel.copilotServices.sessionService.saveMessage(userId, {
        ...assistantMsg,
        metadata: updatedMetadata,
      });
    } catch {
      // Non-critical — history restoration is best-effort
    }
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
    return this.contextAssemblyPipeline.assemble({ ctx, ...input });
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

  private async runSpecialistLoop(
    run: RunState,
    specialist: Agent,
    routeHint: AgentName,
    options: { initialRevisionAttemptCount?: number } = {},
  ): Promise<LoopRunResult> {
    const toolResults: ToolResult[] = [];
    const pendingActions: PendingAction[] = [];
    let lastAssistantMessage = "";
    let criticReview: CriticReview | undefined;
    // Critic auto-revision loop: count consecutive needs_revision verdicts in
    // this specialist run. We retry up to MAX_REVISION_ATTEMPTS times by
    // feeding the critic feedback back to the specialist through the message
    // bus (revision_request) and letting it replan match → generate → review.
    let revisionAttemptCount = options.initialRevisionAttemptCount ?? 0;

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
      const decision = await this.decisionRunner.decide({ agent: specialist, context: run.context, routeHint });
      lastAssistantMessage = decision.assistantMessage || lastAssistantMessage;
      this.addPublicAgentMessage(run, {
        from: specialist.name,
        type: "response",
        content: formatText(localeFor(run), "agentStarted", { agent: agentLabel(specialist.name, localeFor(run)) }),
        payload: { eventType: "announcement", planSize: decision.plan.length },
      });
      this.emit(run, "agent.plan.snapshot", "已生成执行计划", {
        agentName: specialist.name,
        status: "completed",
        payload: {
          summary: `规划 ${decision.plan.length} 个执行步骤`,
          planSize: decision.plan.length,
          tools: decision.plan.map((item) => item.toolName).filter(Boolean).slice(0, 8),
        },
      });
      this.decisionRunner.completeDecisionTrace({
        trace: run.trace,
        step: planStep,
        decision,
        metadata: {
          responseType: decision.responseType,
          stepCount: decision.plan.length,
          loopStep: run.loopController.state.stepCount,
        },
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

      const augmentedPlan = maybeAppendResumeFileImportStep(
        maybeAugmentResumeGenerationPlan(
          maybeAppendJDSaveStep(decision.plan, run.context),
          run.context,
        ),
        run.context,
      );
      const plan = this.validatePlan(augmentedPlan, specialist);
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

      const reviewPipeline = this.createReviewPipeline(run);
      const willReview = reviewPipeline.shouldReviewExecutions(executed.executions);
      if (willReview) {
        this.addPublicAgentMessage(run, {
          from: "critic",
          type: "critique",
          content: t(run, "criticReviewing"),
          payload: { eventType: "announcement" },
        });
        this.emit(run, "agent.critic.started", "正在审查结果…", {
          agentName: "critic",
          status: "running",
        });
      }
      const gateResult = await reviewPipeline.review({
        context: run.context,
        toolExecutions: executed.executions,
        sourceAgent: specialist.name,
      });
      if (willReview) {
        this.addPublicAgentMessage(run, {
          from: "critic",
          type: "critique",
          content: gateResult.status === "pass" ? t(run, "criticPassed") : t(run, "criticNeedsRevision"),
          payload: { eventType: "announcement", status: gateResult.status, verdict: gateResult.review?.verdict },
        });
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
        revisionAttemptCount += 1;
        // Always record a revision_request so the next specialist.decide()
        // sees the critic feedback (review.suggestedFixes / unsupportedClaims /
        // missingEvidence) in agentMessages and can replan accordingly.
        this.recordRevisionRequest(
          run,
          specialist.name,
          gateResult.review,
          revisionAttemptCount,
          revisionAttemptCount < MAX_REVISION_ATTEMPTS
            ? `Critic requested revision (attempt ${revisionAttemptCount}/${MAX_REVISION_ATTEMPTS}). Continuing automatic loop.`
            : `Critic requested revision (attempt ${revisionAttemptCount}/${MAX_REVISION_ATTEMPTS}). Reached the automatic retry cap; surfacing to user.`,
        );

        if (revisionAttemptCount < MAX_REVISION_ATTEMPTS) {
          // Make the auto-revision visible in the AgentRoom: the user sees that
          // the critic flagged issues and the agent is automatically rerunning
          // JD matching + resume generation, rather than the conversation
          // appearing to stall silently.
          this.addPublicAgentMessage(run, {
            from: "critic",
            type: "critique",
            content: revisionRetryAnnouncement(gateResult.review, revisionAttemptCount, MAX_REVISION_ATTEMPTS, localeFor(run)),
            payload: {
              eventType: "announcement",
              status: "needs_revision",
              revisionAttempt: revisionAttemptCount,
              maxAttempts: MAX_REVISION_ATTEMPTS,
              suggestedFixes: gateResult.review?.suggestedFixes,
            },
          });
          // Make sure the loop has budget for at least one more specialist
          // iteration. The base maxSteps is sized for the happy path; each
          // automatic revision retry needs at least one additional slot to
          // re-plan + re-execute + re-review, so extend by one when we're
          // about to exceed the current cap.
          if (run.loopController.state.stepCount + 1 >= run.loopController.state.maxSteps) {
            run.loopController.state.maxSteps += 1;
          }
          this.syncLoopState(run);
          // Loop back: specialist.decide() will see the new revision_request
          // and replan generate_resume_from_jd (and match_experiences_against_jd
          // via maybeAugmentResumeGenerationPlan) for another round.
          continue;
        }

        // Reached the retry cap: stop and surface critic_needs_revision to the
        // user with the latest suggested fixes / unsupported claims / missing
        // evidence, plus the attempts counter so the UI can show "tried 3/3".
        run.loopController.stop("critic_needs_revision");
        this.syncLoopState(run);
        const message = criticRevisionMessage(gateResult.review, localeFor(run));
        const revisionWorkspacePatch = {
          ...mergeWorkspacePatch(toolResults),
          status: "revision_needed",
          summary: gateResult.review?.userVisibleSummary ?? message,
        };
        toolResults.push(needsRevisionResult(message, gateResult.review, {
          attempts: revisionAttemptCount,
          maxAttempts: MAX_REVISION_ATTEMPTS,
        }));
        return {
          assistantText: message,
          toolResults,
          pendingActions,
          workspacePatch: revisionWorkspacePatch,
          criticReview,
        };
      }

      if (executed.toolResults.some(isTerminalDisplayToolResult)) {
        run.loopController.stop("final");
        this.syncLoopState(run);
        return {
          assistantText: assistantFromResults(toolResults, lastAssistantMessage || t(run, "done")),
          toolResults,
          pendingActions,
          workspacePatch: mergeWorkspacePatch(toolResults),
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
    return this.planExecutionService.executePlan(run, plan);
  }

  private createCriticGate(run: RunState): CriticGate {
    return new CriticGate({
      critic: this.agents.critic,
      messageBus: run.messageBus,
      trace: run.trace,
      decisionRunner: this.decisionRunner,
      reviewPolicy: this.reviewPolicy,
      executeCriticPlan: async (criticPlan) => {
        const validPlan = this.validatePlan(criticPlan, this.agents.critic);
        return (await this.executePlan(run, validPlan)).executions;
      },
    });
  }

  private createReviewPipeline(run: RunState): ReviewPipeline {
    return new ReviewPipeline({
      reviewPolicy: this.reviewPolicy,
      createCriticGate: () => this.createCriticGate(run),
      evaluationHooks: this.capabilityRegistry.listEvaluationHooks(),
      learningEventService: this.learningEventService,
    });
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

  private addPublicAgentMessage(
    run: RunState,
    message: {
      from: AgentMessageParticipant;
      type: AgentMessageType;
      content: string;
      payload?: unknown;
    },
  ): void {
    run.messageBus.add({
      from: message.from,
      to: "all",
      type: message.type,
      content: message.content,
      payload: message.payload,
    });
    run.context.agentMessages = run.messageBus.list();
  }

  private recordRevisionRequest(
    run: RunState,
    targetAgent: AgentName,
    review: CriticReview | undefined,
    attempt: number,
    summary: string,
  ): ReturnType<AgentMessageBus["requestRevision"]> {
    const revision = run.messageBus.requestRevision("critic", targetAgent, {
      review,
      attempt,
      maxAttempts: MAX_REVISION_ATTEMPTS,
      autoRevisionAuthorized: run.autoRevisionContext?.autoRevisionAuthorized === true,
    });
    run.context.agentMessages = run.messageBus.list();
    run.trace.add({
      agentName: "AgentOrchestrator",
      type: "reason",
      summary,
      status: "success",
      completedAt: new Date().toISOString(),
      metadata: {
        messageId: revision.id,
        revisionAttemptCount: attempt,
        maxRevisionAttempts: MAX_REVISION_ATTEMPTS,
        autoRevisionAuthorized: run.autoRevisionContext?.autoRevisionAuthorized === true,
      },
    });
    return revision;
  }

  private syncLoopState(run: RunState): void {
    run.loopController.state.observations = run.context.observations ?? [];
    run.context.loopState = run.loopController.state;
    run.context.agentMessages = run.messageBus.list();
  }

  /**
   * Get or execute prepare_save_experience_from_text to produce a structured draft.
   *
   * 1. First checks prior observations for an already-executed prepare result.
   * 2. If not found, executes the prepare tool inline as a read operation.
   * 3. Returns the LLM-structured draft + experienceDraft, or undefined on failure.
   */
  private async getOrExecutePrepareSaveResult(
    run: RunState,
    args: Record<string, unknown>,
  ): Promise<{ draft: Record<string, unknown>; experienceDraft: Record<string, unknown> } | undefined> {
    // 1. Check prior observations for a prepare_save_experience_from_text result
    const observations = run.context.observations ?? [];
    for (const obs of observations) {
      if (obs.toolName === "prepare_save_experience_from_text" && obs.status === "success") {
        const data = obs.data as Record<string, unknown> | undefined;
        if (data?.draft && data?.experienceDraft) {
          return {
            draft: data.draft as Record<string, unknown>,
            experienceDraft: data.experienceDraft as Record<string, unknown>,
          };
        }
      }
    }

    // 2. Execute prepare_save_experience_from_text inline as a read operation
    const prepareTool = this.tools.get("prepare_save_experience_from_text");
    if (!prepareTool) return undefined;

    try {
      const text = typeof args.text === "string" ? args.text : "";
      if (!text.trim()) return undefined;

      const result = await run.executor.executeDefinition(
        prepareTool,
        { text },
        run.context,
      );

      if (result.status === "success") {
        const data = result.data as Record<string, unknown> | undefined;
        if (data?.draft && data?.experienceDraft) {
          // Record this as an observation so downstream code can see it
          const observation: AgentObservation = {
            id: `obs-${Math.random().toString(36).slice(2)}`,
            stepId: "inline-prepare",
            agentName: "experience_receiver",
            toolName: "prepare_save_experience_from_text",
            status: "success",
            message: result.message,
            data: result.data,
            createdAt: new Date().toISOString(),
          };
          run.context.observations = [...(run.context.observations ?? []), observation];
          return {
            draft: data.draft as Record<string, unknown>,
            experienceDraft: data.experienceDraft as Record<string, unknown>,
          };
        }
      }
    } catch {
      // prepare failed — fall through
    }

    return undefined;
  }

  private getPreparedResumeRewriteResult(
    run: RunState,
    args: Record<string, unknown>,
  ): { rewrittenText: string; sourceTextPreview?: string; changes?: unknown[] } | undefined {
    const resumeItemId = stringValue(args.resumeItemId);
    if (!resumeItemId) return undefined;
    const observations = run.context.observations ?? [];
    for (const obs of observations.slice().reverse()) {
      if (obs.toolName !== "prepare_revise_resume_item" || obs.status !== "success") continue;
      const data = obs.data as Record<string, unknown> | undefined;
      if (!data || stringValue(data.resumeItemId) !== resumeItemId) continue;
      const rewrittenText = stringValue(data.rewrittenText);
      if (!rewrittenText) continue;
      return {
        rewrittenText,
        sourceTextPreview: stringValue(data.sourceTextPreview),
        changes: Array.isArray(data.changes) ? data.changes : undefined,
      };
    }
    return undefined;
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
    const hasPublicAgentMessages = (run.context.agentMessages ?? []).some((message) => (
      message.to === "all" || message.to === "orchestrator"
    ));
    if (hasPublicAgentMessages && !sanitized.toolResults.some((result) => result.status === "failed")) {
      this.addPublicAgentMessage(run, {
        from: "frontdesk",
        type: "response",
        content: t(run, "completed"),
        payload: { eventType: "announcement" },
      });
    }
    const assembly = await this.resultAssembler.assemble({
      run,
      locale: localeFor(run),
      assistantText: input.assistantText,
      toolResults: sanitized.toolResults,
      pendingActions: input.pendingActions,
      workspacePatch: input.workspacePatch,
      criticReview: input.criticReview,
      invalidConfirmation: sanitized.invalidCount > 0,
      text: {
        done: t(run, "done"),
        productIntro: t(run, "productIntro"),
        invalidConfirmation: t(run, "invalidConfirmation"),
      },
    });
    const assistantMessage = await this.saveMessage(
      userId,
      run.context.sessionId,
      "assistant",
      assembly.assistantText,
      run.context.turnId,
      assembly.toolResults,
      assembly.assistantMessageMetadata,
    );
    this.emit(run, "agent.message.completed", "回复已生成", {
      agentName: "AgentOrchestrator",
      status: "success",
      payload: { messageId: assistantMessage.id },
    });
    const workspace = await this.saveWorkspace(userId, run.context.sessionId, run.workspace, assembly.workspacePatch, assembly.now);
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
    const response = this.resultAssembler.buildResponse({
      assembly,
      sessionId: run.context.sessionId,
      turnId: run.context.turnId,
      assistantMessage,
      workspace,
      trace: run.trace.trace,
    });
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
    metadata?: CopilotMessageMetadata,
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
      metadata: metadata && Object.keys(metadata).length > 0 ? metadata : undefined,
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
  | "invalidConfirmation"
  | "routingTo"
  | "agentStarted"
  | "toolCompleted"
  | "criticReviewing"
  | "criticPassed"
  | "criticNeedsRevision"
  | "completed";

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
    routingTo: "正在转交给 {agent} 处理。",
    agentStarted: "{agent} 已开始处理。",
    toolCompleted: "工具 {tool} 执行完成。",
    criticReviewing: "正在审查生成结果…",
    criticPassed: "审查通过。",
    criticNeedsRevision: "需要修改。",
    completed: "处理完成。",
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
    routingTo: "Routing to {agent}.",
    agentStarted: "{agent} has started.",
    toolCompleted: "Tool {tool} completed.",
    criticReviewing: "Reviewing the generated result…",
    criticPassed: "Review passed.",
    criticNeedsRevision: "Revision needed.",
    completed: "Processing complete.",
  },
};

const AGENT_LABELS: Record<AgentName, Record<CopilotLocale, string>> = {
  frontdesk: { "zh-CN": "前台接待 Agent", en: "Front Desk Agent" },
  experience_receiver: { "zh-CN": "经历编目员 Agent", en: "Experience Cataloger Agent" },
  strategist: { "zh-CN": "JD 分析师 Agent", en: "JD Analyst Agent" },
  architect: { "zh-CN": "简历改写 Agent", en: "Resume Architect Agent" },
  critic: { "zh-CN": "证据审查 Agent", en: "Evidence Reviewer Agent" },
};

function agentLabel(agentName: AgentName, locale: CopilotLocale = "zh-CN"): string {
  return AGENT_LABELS[agentName]?.[locale] ?? "Agent";
}

function localeFor(run: RunState): CopilotLocale {
  return inferLocaleForRun(run);
}

/**
 * Locale inference for system-injected userMessages.
 *
 * `request_explicit_action` and confirmation flows synthesise userMessages
 * like `[action] generate_resume_from_jd` or `[confirm] save_jd`, which are
 * pure ASCII and would always trip `detectLocale` into picking "en" — even
 * for sessions whose entire chat history has been Chinese. To avoid that we:
 *   1. Honour an explicit `clientState.locale` first (most reliable signal).
 *   2. If the current `userMessage` is a `[action] ...` / `[confirm] ...`
 *      placeholder, walk back through `workspace.handoffs[].userGoal` for the
 *      most recent natural-language turn and detect from that instead.
 *   3. Otherwise fall back to `detectLocale(userMessage, clientState)`.
 *
 * Public contract is unchanged: only this internal helper now knows about
 * the placeholder convention; `detectLocale` keeps its existing signature.
 */
export function inferLocaleForRun(run: RunState): CopilotLocale {
  const clientState = run.context.clientState;
  const requested = clientState?.locale?.toLowerCase();
  if (requested?.startsWith("zh")) return "zh-CN";
  if (requested?.startsWith("en")) return "en";

  const message = run.context.userMessage ?? "";
  if (isSystemInjectedUserMessage(message)) {
    const handoffs = run.workspace?.handoffs ?? [];
    for (let i = handoffs.length - 1; i >= 0; i -= 1) {
      const goal = handoffs[i]?.userGoal;
      if (typeof goal === "string" && goal.trim() && !isSystemInjectedUserMessage(goal)) {
        return detectLocale(goal, clientState);
      }
    }
  }
  return detectLocale(message, clientState);
}

function isSystemInjectedUserMessage(message: string): boolean {
  return /^\[(action|confirm)\]\s/.test(message);
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

function needsRevisionResult(
  message: string,
  review?: CriticReview,
  retryInfo?: { attempts: number; maxAttempts: number },
): ToolResult {
  return {
    status: "needs_input",
    message,
    visibility: "action_required",
    actionResult: {
      actionType: "critic_gate",
      status: "needs_input",
      message,
      reason: "critic_needs_revision",
      metadata: review || retryInfo ? {
        ...(review ? {
          verdict: review.verdict,
          riskLevel: review.riskLevel,
          unsupportedClaims: review.unsupportedClaims,
          missingEvidence: review.missingEvidence,
          suggestedFixes: review.suggestedFixes,
        } : {}),
        ...(retryInfo ? {
          attempts: retryInfo.attempts,
          maxAttempts: retryInfo.maxAttempts,
        } : {}),
      } : undefined,
    },
  };
}

function criticRevisionMessage(review: CriticReview | undefined, locale: CopilotLocale): string {
  const summary = review?.userVisibleSummary || (locale === "zh-CN" ? "结果需要修改后才能使用。" : "The result needs revision before it can be used.");
  const fixes = review?.suggestedFixes?.filter(Boolean) ?? [];
  if (fixes.length === 0) return summary;
  const label = locale === "zh-CN" ? "建议修改：" : "Suggested fixes:";
  return `${summary}\n${label}\n${fixes.map((fix) => `- ${fix}`).join("\n")}`;
}

function revisionRetryAnnouncement(
  review: CriticReview | undefined,
  attempt: number,
  maxAttempts: number,
  locale: CopilotLocale,
): string {
  const fixes = (review?.suggestedFixes ?? []).filter(Boolean).slice(0, 3);
  if (locale === "zh-CN") {
    const head = `审查发现需要修改（第 ${attempt}/${maxAttempts} 次），正在自动重新匹配并重写。`;
    return fixes.length ? `${head}\n建议修改：\n${fixes.map((fix) => `- ${fix}`).join("\n")}` : head;
  }
  const head = `Critic flagged revisions (attempt ${attempt}/${maxAttempts}). Re-running JD match and resume generation automatically.`;
  return fixes.length ? `${head}\nSuggested fixes:\n${fixes.map((fix) => `- ${fix}`).join("\n")}` : head;
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

function isTerminalDisplayToolResult(result: ToolResult): boolean {
  if (result.status !== "success" || result.visibility === "internal") return false;
  const actionType = result.actionResult?.actionType;
  return actionType === "analyze_jd"
    || actionType === "import_experience_candidates_from_text"
    || actionType === "import_resume_file_as_candidates"
    || actionType === "accept_import_candidate"
    || actionType === "reject_import_candidate"
    || actionType === "list_experiences"
    || actionType === "search_experiences"
    || actionType === "match_experiences_against_jd";
}

function debugConfirm(event: string, payload: Record<string, unknown>): void {
  if (process.env.DEBUG_CONFIRM !== "true" && process.env.NODE_ENV !== "development") return;
  if (process.env.DEBUG_CONFIRM === "false") return;
  console.debug("[pending-action-confirm]", { event, ...payload });
}

function readGenerationId(result: ToolResult): string | undefined {
  const data = isRecord(result.data) ? result.data : null;
  const generation = isRecord(data?.generation) ? data.generation : null;
  const metadata = isRecord(result.actionResult?.metadata) ? result.actionResult.metadata : null;
  return stringValue(data?.generationId) ?? stringValue(generation?.id) ?? stringValue(metadata?.generationId);
}

function readVariantCount(result: ToolResult): number {
  const data = isRecord(result.data) ? result.data : null;
  if (Array.isArray(data?.variants)) return data.variants.length;
  const metadata = isRecord(result.actionResult?.metadata) ? result.actionResult.metadata : null;
  const metadataCount = numberValue(metadata?.variantCount);
  return metadataCount ?? 0;
}

function isGenerationQueuedResult(result: ToolResult): boolean {
  const data = isRecord(result.data) ? result.data : null;
  const metadata = isRecord(result.actionResult?.metadata) ? result.actionResult.metadata : null;
  return result.actionResult?.actionType === "generate_resume_from_jd"
    && (
      metadata?.generating === true
      || stringValue(metadata?.jobId) !== undefined
      || stringValue(data?.jobId) !== undefined
    );
}













const BLOCKED_METADATA_KEYS = new Set([
  "systemPrompt",
  "system_prompt",
  "toolArguments",
  "tool_args",
  "toolArgs",
  "reasoning_content",
  "chainOfThought",
  "cot",
  "providerRawPayload",
  "rawProviderPayload",
  "rawRequest",
  "rawResponse",
  "apiKey",
  "authorization",
]);

function assistantFromResults(results: ToolResult[], fallback: string): string {
  const visible = results
    .filter((result) => result.visibility === "user_summary" || result.visibility === "action_required" || result.visibility === "error_user_visible")
    .map((result) => result.message)
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0 && !isBlockedToolLog(item));
  if (visible.length > 0) return visible.join("\n");
  return fallback;
}

function maybeAugmentResumeGenerationPlan(plan: PlanStep[], context: AgentContext): PlanStep[] {
  const generateIndex = plan.findIndex((step) => step.toolName === "generate_resume_from_jd");
  if (generateIndex < 0) return plan;
  if (plan.some((step) => step.toolName === "match_experiences_against_jd")) return plan;

  const generateStep = plan[generateIndex];
  const args = (generateStep.arguments ?? {}) as Record<string, unknown>;
  const jdText =
    stringValue(args.jdText)
    ?? stringValue(context.productContext.requestJDText)
    ?? stringValue((context.productContext.frontDeskHandoff as { extracted?: { jdText?: string } } | undefined)?.extracted?.jdText);
  const jdId =
    stringValue(args.jdId)
    ?? stringValue((context.productContext.frontDeskHandoff as { extracted?: { jdId?: string } } | undefined)?.extracted?.jdId);
  if (!jdText && !jdId) return plan;

  const matchStep: PlanStep = {
    id: `${generateStep.id}-match`,
    agentName: generateStep.agentName,
    toolName: "match_experiences_against_jd",
    arguments: {
      ...(jdId ? { jdId } : {}),
      ...(jdText ? { jdText } : {}),
      limit: 20,
    },
    summary: "Match experiences against JD before resume generation.",
  };

  return [
    ...plan.slice(0, generateIndex),
    matchStep,
    ...plan.slice(generateIndex),
  ];
}

function maybeAppendJDSaveStep(plan: PlanStep[], context: AgentContext): PlanStep[] {
  if (!shouldSaveJDFromMessage(context.userMessage)) return plan;
  if (plan.some((step) => step.toolName === "save_jd_from_text" || step.toolName === "prepare_save_jd_from_text")) return plan;
  const matchStep = plan.find((step) => step.toolName === "match_experiences_against_jd");
  if (!matchStep) return plan;
  const args = (matchStep.arguments ?? {}) as Record<string, unknown>;
  const jdText =
    stringValue(args.jdText)
    ?? stringValue(context.productContext.requestJDText)
    ?? stringValue((context.productContext.frontDeskHandoff as { extracted?: { jdText?: string } } | undefined)?.extracted?.jdText);
  if (!jdText) return plan;
  return [
    ...plan,
    {
      id: `${matchStep.id}-save-jd`,
      agentName: matchStep.agentName,
      toolName: "save_jd_from_text",
      arguments: { text: jdText },
      summary: "Save JD after matching results.",
    },
  ];
}

function maybeAppendResumeFileImportStep(plan: PlanStep[], context: AgentContext): PlanStep[] {
  if (!isResumeFileImportMessage(context.userMessage)) return plan;
  const importRequest = extractResumeFileImportRequest(context);
  if (plan.some((step) => step.toolName === "import_resume_file_as_candidates")) return plan;
  return [{
    id: "step-import-resume-file",
    agentName: "experience_receiver",
    toolName: "import_resume_file_as_candidates",
    arguments: importRequest ?? {},
    summary: "Parse uploaded resume file into editable experience candidates.",
  }];
}

function extractResumeFileImportRequest(context: AgentContext): { fileId: string; originalName?: string; mimeType?: string; size?: number; source: "resume_upload" | "file_upload" | "copilot" } | undefined {
  if (!isResumeFileImportMessage(context.userMessage)) return undefined;
  const clientState = context.clientState ?? {};
  const resumeUpload: Record<string, unknown> | undefined = isRecord(clientState.resumeUpload) ? clientState.resumeUpload : undefined;
  const productResumeUpload = isRecord(context.productContext.resumeUpload) ? context.productContext.resumeUpload : undefined;
  const fileId =
    stringValue(resumeUpload?.fileId)
    ?? stringValue(resumeUpload?.id)
    ?? stringValue(productResumeUpload?.fileId)
    ?? stringValue(clientState.fileId)
    ?? stringValue(clientState.activeFileId)
    ?? stringValue(clientState.resumeFileId)
    ?? stringValue(clientState.uploadedFileId)
    ?? stringValue(context.productContext.activeFileId)
    ?? stringValue(context.productContext.resumeFileId)
    ?? extractFileIdFromMessage(context.userMessage);
  if (!fileId) return undefined;
  const originalName =
    stringValue(resumeUpload?.originalName)
    ?? stringValue(resumeUpload?.fileName)
    ?? stringValue(resumeUpload?.name)
    ?? stringValue(productResumeUpload?.originalName)
    ?? stringValue(clientState.originalName)
    ?? stringValue(clientState.fileName)
    ?? extractOriginalNameFromMessage(context.userMessage);
  const mimeType = stringValue(resumeUpload?.mimeType) ?? stringValue(productResumeUpload?.mimeType);
  const size = numberValue(resumeUpload?.size) ?? numberValue(productResumeUpload?.size);
  return {
    fileId,
    originalName,
    mimeType,
    size,
    source: "resume_upload",
  };
}

function isResumeFileImportMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("import resume")
    || lower.includes("parse resume")
    || lower.includes("resume upload")
    || lower.includes("extract experience")
    || message.includes("导入简历")
    || message.includes("上传简历")
    || message.includes("解析简历")
    || message.includes("从文件提取经历")
    || message.includes("从这个文件中提取经历")
    || message.includes("上传了简历文件")
    || (message.includes("简历") && message.includes("fileId"));
}

function extractResumeUploadAttachment(clientState: CopilotClientState | undefined): CopilotMessageAttachment | undefined {
  if (!clientState) return undefined;
  const resumeUpload: Record<string, unknown> | undefined = isRecord(clientState.resumeUpload) ? clientState.resumeUpload : undefined;
  const fileId =
    stringValue(resumeUpload?.fileId)
    ?? stringValue(resumeUpload?.id)
    ?? stringValue(clientState.activeFileId)
    ?? stringValue(clientState.resumeFileId)
    ?? stringValue(clientState.uploadedFileId)
    ?? stringValue(clientState.fileId);
  if (!fileId) return undefined;
  const originalName =
    stringValue(resumeUpload?.originalName)
    ?? stringValue(resumeUpload?.fileName)
    ?? stringValue(resumeUpload?.name)
    ?? stringValue(clientState.originalName)
    ?? stringValue(clientState.fileName)
    ?? "Uploaded resume";
  return {
    id: stringValue(resumeUpload?.id),
    fileId,
    originalName,
    mimeType: stringValue(resumeUpload?.mimeType),
    size: numberValue(resumeUpload?.size),
    kind: "resume_upload",
  };
}

function buildUserMessageMetadata(attachment: CopilotMessageAttachment | undefined): CopilotMessageMetadata | undefined {
  if (!attachment?.fileId) return undefined;
  return {
    attachments: [attachment],
  };
}

function buildResumeUploadProductContext(attachment: CopilotMessageAttachment | undefined): Record<string, unknown> {
  if (!attachment?.fileId) return {};
  return {
    resumeUpload: {
      fileId: attachment.fileId,
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
      size: attachment.size,
      source: "composer",
    },
    activeFileId: attachment.fileId,
    resumeFileId: attachment.fileId,
  };
}

function extractFileIdFromMessage(message: string): string | undefined {
  return message.match(/\bfileId\s*[:=]\s*([A-Za-z0-9_-]+)/i)?.[1]
    ?? message.match(/\b(file-[A-Za-z0-9_-]+)/)?.[1];
}

function extractOriginalNameFromMessage(message: string): string | undefined {
  return message.match(/(?:导入简历|解析简历|resume)[:：]\s*([^\n，,]+?\.(?:pdf|docx|txt))/i)?.[1]?.trim();
}

function shouldSaveJDFromMessage(message: string): boolean {
  const text = message.toLowerCase();
  const mentionsJD = text.includes("jd") || text.includes("岗位");
  if (!mentionsJD) return false;
  return text.includes("保存") || text.includes("入库") || text.includes("记录") || text.includes("save");
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

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
