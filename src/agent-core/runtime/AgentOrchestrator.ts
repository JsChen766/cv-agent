import { randomUUID } from "node:crypto";
import type { ApiKernel } from "../../api/types.js";
import { ActiveAssetContextBuilder } from "../../copilot/ActiveAssetContextBuilder.js";
import type {
  CopilotActionRequest,
  CopilotActionResult,
  CopilotChatRequest,
  CopilotChatResponse,
  CopilotMessage,
  CopilotWorkspace,
  ProductTimelineItem,
} from "../../copilot/types.js";
import { createAgentTools } from "../../agent-tools/index.js";
import type { PendingAction } from "../confirmation/PendingAction.js";
import { PendingActionService } from "../confirmation/PendingActionService.js";
import { ArchitectAgent } from "../agents/ArchitectAgent.js";
import type { Agent } from "../agents/BaseAgent.js";
import { CriticAgent } from "../agents/CriticAgent.js";
import { ExperienceReceiverAgent } from "../agents/ExperienceReceiverAgent.js";
import { FrontDeskAgent } from "../agents/FrontDeskAgent.js";
import { StrategistAgent } from "../agents/StrategistAgent.js";
import { PromptRegistry } from "../prompts/PromptRegistry.js";
import type { ToolDefinition } from "../tools/Tool.js";
import { ToolExecutor } from "../tools/ToolExecutor.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolResult } from "../tools/ToolResult.js";
import type { AgentName, PlanStep } from "../validation/AgentOutputSchemas.js";
import type { KernelRequestContext } from "../../kernel/context.js";
import type { AgentContext } from "./AgentContext.js";
import { AgentError } from "./AgentError.js";
import { AgentTraceRecorder } from "./AgentTrace.js";

export type AgentOrchestratorDeps = {
  kernel: ApiKernel;
  pendingActions?: PendingActionService;
};

type RunState = {
  context: AgentContext;
  trace: AgentTraceRecorder;
  executor: ToolExecutor;
  workspace: CopilotWorkspace | null;
};

type ExecutedPlan = {
  toolResults: ToolResult[];
  pendingActions: PendingAction[];
};

export class AgentOrchestrator {
  public readonly pendingActions: PendingActionService;
  public readonly tools: ToolRegistry;
  private readonly activeAssetContextBuilder: ActiveAssetContextBuilder;
  private readonly agents: Record<AgentName, Agent>;

  public constructor(private readonly deps: AgentOrchestratorDeps) {
    const promptRegistry = new PromptRegistry();
    this.pendingActions = deps.pendingActions ?? new PendingActionService();
    this.tools = new ToolRegistry();
    this.tools.registerMany(createAgentTools());
    this.activeAssetContextBuilder = new ActiveAssetContextBuilder(deps.kernel);
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

  public async handleChat(ctx: KernelRequestContext, request: CopilotChatRequest): Promise<CopilotChatResponse> {
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
      },
    });

    try {
      const frontDeskStep = run.trace.add({
        agentName: "frontdesk",
        type: "reason",
        summary: "Classifying and routing the user request.",
        status: "running",
      });
      const frontDeskDecision = await this.agents.frontdesk.decide({ context: run.context });
      run.trace.complete(frontDeskStep, "success", {
        routeTo: frontDeskDecision.routeTo,
        responseType: frontDeskDecision.responseType,
      });

      if (frontDeskDecision.responseType === "ask_clarification" || !frontDeskDecision.routeTo) {
        return this.finishRun(ctx.user.id, run, {
          assistantText: frontDeskDecision.assistantMessage || "Please provide the missing input so I can continue.",
          toolResults: [],
          pendingActions: [],
          workspacePatch: {},
        });
      }

      const specialist = this.agents[frontDeskDecision.routeTo];
      const planStep = run.trace.add({
        agentName: specialist.name,
        type: "plan",
        summary: `Planning with ${specialist.name}.`,
        status: "running",
      });
      const specialistDecision = await specialist.decide({ context: run.context, routeHint: frontDeskDecision.routeTo });
      const plan = this.validatePlan(specialistDecision.plan, specialist);
      run.trace.complete(planStep, "success", { stepCount: plan.length });

      const executed = await this.executePlan(run, plan);
      return this.finishRun(ctx.user.id, run, {
        assistantText: assistantFromResults(executed.toolResults, specialistDecision.assistantMessage),
        toolResults: executed.toolResults,
        pendingActions: executed.pendingActions,
        workspacePatch: mergeWorkspacePatch(executed.toolResults),
      });
    } catch (error) {
      return this.finishError(ctx.user.id, run, error);
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

    const mapped = this.mapExplicitAction(request, run.workspace);
    if (!mapped) {
      const result = failedActionResult(request.action.type, "Unsupported copilot action.");
      return this.finishRun(ctx.user.id, run, {
        assistantText: result.message ?? "Unsupported action.",
        toolResults: [result],
        pendingActions: [],
        workspacePatch: {},
      });
    }

    try {
      const executed = await this.executePlan(run, [mapped]);
      return this.finishRun(ctx.user.id, run, {
        assistantText: assistantFromResults(executed.toolResults, ""),
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
    const { result } = await this.pendingActions.confirm({
      userId: ctx.user.id,
      id,
      registry: this.tools,
      executor: run.executor,
      context: run.context,
    });
    run.trace.add({
      agentName: "AgentOrchestrator",
      type: "final",
      summary: `Executed pending action ${id}.`,
      status: "success",
      completedAt: new Date().toISOString(),
    });
    return this.finishRun(ctx.user.id, run, {
      assistantText: result.message ?? "Confirmed and executed.",
      toolResults: [result],
      pendingActions: [],
      workspacePatch: mergeWorkspacePatch([result]),
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
    },
  ): Promise<RunState> {
    const [workspace, recentMessages] = await Promise.all([
      this.deps.kernel.copilotServices.workspaceService.getWorkspace(ctx.user.id, input.sessionId),
      this.deps.kernel.copilotServices.sessionService.getRecentMessages(ctx.user.id, input.sessionId, 8),
    ]);
    const trace = new AgentTraceRecorder();
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
      activeAssetContext: await this.activeAssetContextBuilder.build({ userId: ctx.user.id, request: input.request, workspace }),
      productContext: input.productContext,
      availableTools: this.tools.list(),
      trace: trace.trace,
    };
    return {
      context,
      trace,
      executor: new ToolExecutor(this.tools, trace),
      workspace,
    };
  }

  private async executePlan(run: RunState, plan: PlanStep[]): Promise<ExecutedPlan> {
    const toolResults: ToolResult[] = [];
    const pendingActions: PendingAction[] = [];
    for (const step of plan) {
      if (!step.toolName) continue;
      const result = await this.executeToolOrCreatePendingAction(run, step);
      toolResults.push(result.result);
      if (result.pendingAction) pendingActions.push(result.pendingAction);
    }
    return { toolResults, pendingActions };
  }

  private async executeToolOrCreatePendingAction(
    run: RunState,
    step: PlanStep,
  ): Promise<{ result: ToolResult; pendingAction?: PendingAction }> {
    const tool = this.tools.get(step.toolName ?? "");
    if (!tool) throw new AgentError("TOOL_NOT_FOUND", "Planned tool is not registered.", { statusCode: 404 });
    const parsed = tool.inputSchema.safeParse(step.arguments);
    if (!parsed.success) {
      return { result: failedActionResult(tool.name, "The action is missing required input.") };
    }
    const args = parsed.data as Record<string, unknown>;
    if (!tool.requiresConfirmation) {
      return { result: await run.executor.executeDefinition(tool, args, run.context) };
    }

    const pending = await this.pendingActions.create({
      userId: run.context.userId,
      sessionId: run.context.sessionId,
      turnId: run.context.turnId,
      tool,
      toolArguments: args,
      title: step.summary,
      summary: confirmationSummary(tool.name),
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
    return {
      pendingAction: pending,
      result: {
        status: "needs_input",
        message: pending.summary,
        pendingActionId: pending.id,
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

  private mapExplicitAction(request: CopilotActionRequest, workspace: CopilotWorkspace | null): PlanStep | undefined {
    const payload = request.action.payload ?? {};
    const clientState = request.clientState ?? {};
    const id = request.action.variantId ?? stringValue(payload.id) ?? stringValue(payload.evidenceId) ?? clientState.activeVariantId;
    switch (request.action.type) {
      case "show_evidence":
      case "explain_choice":
        return explicitStep("critic", "show_evidence", { id: id ?? "current" }, "Show evidence.");
      case "export_resume":
        return explicitStep("architect", "export_resume", {
          resumeId: stringValue(payload.resumeId) ?? clientState.activeResumeId ?? workspace?.resumeId,
          format: payload.format ?? "html",
          templateId: stringValue(payload.templateId),
        }, "Export resume after confirmation.");
      case "generate_from_jd":
        return explicitStep("architect", "generate_resume_from_jd", {
          jdId: stringValue(payload.jdId) ?? clientState.activeJDId ?? workspace?.jdId,
          jdText: stringValue(payload.jdText),
          targetRole: stringValue(payload.targetRole),
        }, "Generate resume from JD after confirmation.");
      case "optimize_resume_item":
        return explicitStep("architect", "revise_resume_item", {
          resumeItemId: stringValue(payload.resumeItemId) ?? clientState.activeResumeItemId,
          instruction: stringValue(payload.instruction) ?? stringValue(payload.selectedText) ?? clientState.selectedText ?? "Revise this resume item.",
        }, "Revise resume item after confirmation.");
      default:
        return undefined;
    }
  }

  private async finishError(userId: string, run: RunState, error: unknown): Promise<CopilotChatResponse> {
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
    });
  }

  private async finishRun(
    userId: string,
    run: RunState,
    input: {
      assistantText: string;
      toolResults: ToolResult[];
      pendingActions: PendingAction[];
      workspacePatch: Record<string, unknown>;
    },
  ): Promise<CopilotChatResponse> {
    run.trace.add({
      agentName: "AgentOrchestrator",
      type: "final",
      summary: "Prepared user-visible response.",
      status: "success",
      completedAt: new Date().toISOString(),
    });
    const now = new Date().toISOString();
    const assistantMessage = await this.saveMessage(userId, run.context.sessionId, "assistant", input.assistantText, run.context.turnId, input.toolResults);
    const workspace = await this.saveWorkspace(userId, run.context.sessionId, run.workspace, input.workspacePatch, now);
    await this.deps.kernel.copilotServices.sessionService.completeTurn(userId, run.context.turnId, assistantMessage.id);
    await this.deps.kernel.copilotServices.workspaceService.recordActivity(userId, {
      sessionId: run.context.sessionId,
      type: "chat",
      title: "Copilot replied",
      metadata: { traceRunId: run.trace.trace.runId },
    });
    return {
      sessionId: run.context.sessionId,
      turnId: run.context.turnId,
      assistantMessage,
      timeline: timelineFor(input.toolResults, now, run.context.turnId),
      workspace,
      nextActions: [],
      raw: {
        artifactIds: [],
        evidenceChainIds: [],
        critiqueItemIds: [],
        decisionIds: [],
        agentTrace: run.trace.trace,
        toolResults: input.toolResults,
        pendingActions: input.pendingActions,
        actionResults: input.toolResults
          .map((result) => result.actionResult)
          .filter((item): item is CopilotActionResult => item !== undefined && typeof item.status === "string"),
      },
    };
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

function failedActionResult(actionType: string, message: string, reason = "unsupported_action"): ToolResult {
  return {
    status: "failed",
    message,
    actionResult: { actionType, status: "failed", message, reason },
  };
}

function mergeWorkspacePatch(results: ToolResult[]): Record<string, unknown> {
  return results.reduce<Record<string, unknown>>((merged, result) => ({ ...merged, ...(result.workspacePatch ?? {}) }), {});
}

function assistantFromResults(results: ToolResult[], fallback: string): string {
  const messages = results.map((result) => result.message).filter((item): item is string => Boolean(item));
  if (messages.length > 0) return messages.join("\n");
  return fallback || "Done.";
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

function confirmationSummary(toolName: string): string {
  if (toolName === "save_experience_from_text") return "Please confirm saving this experience to your library.";
  if (toolName === "update_experience") return "Please confirm updating this experience.";
  if (toolName === "delete_experience") return "Please confirm deleting this experience.";
  if (toolName === "export_resume") return "Please confirm creating this resume export.";
  return `Please confirm ${toolName}.`;
}

function affectedResourcesFor(toolName: string, args: Record<string, unknown>) {
  if (toolName.includes("experience")) return [{ type: "experience" as const, id: stringValue(args.experienceId) }];
  if (toolName.includes("jd")) return [{ type: "jd" as const, id: stringValue(args.jdId) }];
  if (toolName.includes("resume")) return [{ type: "resume" as const, id: stringValue(args.resumeId) }];
  if (toolName.includes("export")) return [{ type: "export" as const }];
  return [];
}

function previewFor(toolName: string, args: Record<string, unknown>) {
  if (toolName === "save_experience_from_text") return { after: { text: args.text } };
  if (toolName === "update_experience") return { after: args };
  if (toolName === "delete_experience") return { before: args };
  if (toolName === "export_resume") return { after: args };
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
