import { randomUUID } from "node:crypto";
import type { ApiKernel } from "../../api/types.js";
import { ActiveAssetContextBuilder } from "../../copilot/ActiveAssetContextBuilder.js";
import type {
  CopilotChatRequest,
  CopilotChatResponse,
  CopilotActionResult,
  CopilotMessage,
  CopilotWorkspace,
  ProductTimelineItem,
} from "../../copilot/types.js";
import type { PendingAction } from "../confirmation/PendingAction.js";
import type { KernelRequestContext } from "../../kernel/context.js";
import { createAgentTools } from "../../agent-tools/index.js";
import { ArchitectAgent } from "../agents/ArchitectAgent.js";
import type { Agent } from "../agents/BaseAgent.js";
import { CriticAgent } from "../agents/CriticAgent.js";
import { ExperienceReceiverAgent } from "../agents/ExperienceReceiverAgent.js";
import { FrontDeskAgent } from "../agents/FrontDeskAgent.js";
import { StrategistAgent } from "../agents/StrategistAgent.js";
import { PendingActionService } from "../confirmation/PendingActionService.js";
import { PromptRegistry } from "../prompts/PromptRegistry.js";
import { ToolExecutor } from "../tools/ToolExecutor.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolResult } from "../tools/ToolResult.js";
import type { AgentName, PlanStep } from "../validation/AgentOutputSchemas.js";
import type { AgentContext } from "./AgentContext.js";
import { AgentError } from "./AgentError.js";
import { AgentTraceRecorder } from "./AgentTrace.js";

export type AgentOrchestratorDeps = {
  kernel: ApiKernel;
  pendingActions?: PendingActionService;
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
    const userMessage = await this.saveUserMessage(ctx.user.id, session.id, request.message);
    const turn = await this.deps.kernel.copilotServices.sessionService.createTurn(ctx.user.id, session.id, userMessage.id);
    const [workspace, recentMessages] = await Promise.all([
      this.deps.kernel.copilotServices.workspaceService.getWorkspace(ctx.user.id, session.id),
      this.deps.kernel.copilotServices.sessionService.getRecentMessages(ctx.user.id, session.id, 8),
    ]);
    const trace = new AgentTraceRecorder();
    const context: AgentContext = {
      kernel: this.deps.kernel,
      requestContext: ctx,
      userId: ctx.user.id,
      sessionId: session.id,
      turnId: turn.id,
      userMessage: request.message,
      recentMessages,
      workspace,
      clientState: request.clientState,
      activeAssetContext: await this.activeAssetContextBuilder.build({ userId: ctx.user.id, request, workspace }),
      productContext: { targetRole: request.targetRole ?? session.targetRole, hasJDText: Boolean(request.jdText ?? session.jdText) },
      availableTools: this.tools.list(),
      trace: trace.trace,
    };
    const executor = new ToolExecutor(this.tools, trace);
    const toolResults: ToolResult[] = [];
    const createdPendingActions: PendingAction[] = [];

    try {
      const frontDeskStep = trace.add({ agentName: "frontdesk", type: "reason", summary: "Classifying and routing the user request.", status: "running" });
      const frontDeskDecision = await this.agents.frontdesk.decide({ context });
      trace.complete(frontDeskStep, "success", { routeTo: frontDeskDecision.routeTo, responseType: frontDeskDecision.responseType });

      if (frontDeskDecision.responseType === "ask_clarification" || !frontDeskDecision.routeTo) {
        return await this.finish(ctx.user.id, session.id, turn.id, context, workspace, {
          assistantText: frontDeskDecision.assistantMessage || "Please provide the missing input so I can continue.",
          toolResults,
          trace,
          pendingActions: createdPendingActions,
          workspacePatch: {},
        });
      }

      const agent = this.agents[frontDeskDecision.routeTo];
      const planStep = trace.add({ agentName: agent.name, type: "plan", summary: `Planning with ${agent.name}.`, status: "running" });
      const specialistDecision = await agent.decide({ context, routeHint: frontDeskDecision.routeTo });
      const plan = this.validatePlan(specialistDecision.plan, agent);
      trace.complete(planStep, "success", { stepCount: plan.length });

      for (const step of plan) {
        if (!step.toolName) continue;
        const tool = this.tools.get(step.toolName);
        if (!tool) throw new AgentError("TOOL_NOT_FOUND", "Planned tool is not registered.", { statusCode: 404 });
        if (tool.requiresConfirmation) {
          const pending = this.pendingActions.create({
            userId: ctx.user.id,
            sessionId: session.id,
            turnId: turn.id,
            tool,
            toolArguments: step.arguments,
            title: step.summary,
            summary: confirmationSummary(tool.name, step.arguments),
            affectedResources: affectedResourcesFor(tool.name, step.arguments),
            preview: previewFor(tool.name, step.arguments),
          });
          createdPendingActions.push(pending);
          trace.add({
            agentName: agent.name,
            type: "confirmation_required",
            summary: `Confirmation required for ${tool.name}.`,
            toolName: tool.name,
            status: "needs_input",
            completedAt: new Date().toISOString(),
            metadata: { pendingActionId: pending.id },
          });
          toolResults.push({
            status: "needs_input",
            message: pending.summary,
            pendingActionId: pending.id,
            actionResult: { status: "needs_confirmation", actionType: tool.name, pendingActionId: pending.id },
          });
          continue;
        }
        const result = await executor.execute(tool.name, step.arguments, context);
        toolResults.push(result);
      }

      await this.createDeleteFromUniqueSearchIfNeeded(ctx.user.id, session.id, turn.id, request.message, toolResults, trace);

      return await this.finish(ctx.user.id, session.id, turn.id, context, workspace, {
        assistantText: assistantFromResults(toolResults, specialistDecision.assistantMessage),
        toolResults,
        trace,
        pendingActions: [...createdPendingActions, ...this.pendingActions.list(ctx.user.id, session.id).filter((item) => item.turnId === turn.id && !createdPendingActions.some((existing) => existing.id === item.id))],
        workspacePatch: mergeWorkspacePatch(toolResults),
      });
    } catch (error) {
      const agentError = error instanceof AgentError ? error : new AgentError("TOOL_EXECUTION_FAILED", "Agent run failed.", { cause: error });
      trace.add({ agentName: "AgentOrchestrator", type: "error", summary: agentError.code, status: "failed", completedAt: new Date().toISOString() });
      return await this.finish(ctx.user.id, session.id, turn.id, context, workspace, {
        assistantText: agentError.toUserMessage(),
        toolResults,
        trace,
        pendingActions: createdPendingActions,
        workspacePatch: {},
      });
    }
  }

  public async confirmPendingAction(ctx: KernelRequestContext, id: string): Promise<CopilotChatResponse> {
    const action = this.pendingActions.get(ctx.user.id, id);
    if (!action) throw new AgentError("PERMISSION_DENIED", "Pending action not found.", { statusCode: 404 });
    const session = await this.deps.kernel.copilotServices.sessionService.getSession(ctx.user.id, action.sessionId);
    if (!session) throw new AgentError("PRODUCT_STATE_NOT_FOUND", "Session not found.", { statusCode: 404 });
    const workspace = await this.deps.kernel.copilotServices.workspaceService.getWorkspace(ctx.user.id, session.id);
    const trace = new AgentTraceRecorder();
    const context: AgentContext = {
      kernel: this.deps.kernel,
      requestContext: ctx,
      userId: ctx.user.id,
      sessionId: session.id,
      turnId: action.turnId ?? `ct-${randomUUID()}`,
      userMessage: `confirm ${action.toolName}`,
      recentMessages: await this.deps.kernel.copilotServices.sessionService.getRecentMessages(ctx.user.id, session.id, 8),
      workspace,
      clientState: {},
      productContext: {},
      availableTools: this.tools.list(),
      trace: trace.trace,
    };
    const executor = new ToolExecutor(this.tools, trace);
    const { result } = await this.pendingActions.confirm({
      userId: ctx.user.id,
      id,
      registry: this.tools,
      executor,
      context,
    });
    trace.add({ agentName: "AgentOrchestrator", type: "final", summary: `Executed pending action ${id}.`, status: "success", completedAt: new Date().toISOString() });
    return this.finish(ctx.user.id, session.id, context.turnId, context, workspace, {
      assistantText: result.message ?? "Confirmed and executed.",
      toolResults: [result],
      trace,
      pendingActions: [],
      workspacePatch: mergeWorkspacePatch([result]),
    });
  }

  private validatePlan(plan: PlanStep[], agent: Agent): PlanStep[] {
    return plan.map((step) => {
      if (step.agentName !== agent.name) throw new AgentError("INVALID_AGENT_OUTPUT", "Plan step agent mismatch.", { statusCode: 502 });
      if (step.toolName && !agent.allowedTools.includes(step.toolName)) {
        throw new AgentError("TOOL_NOT_FOUND", "Tool is not allowed for this agent.", { statusCode: 403 });
      }
      return step;
    });
  }

  private async createDeleteFromUniqueSearchIfNeeded(
    userId: string,
    sessionId: string,
    turnId: string,
    message: string,
    results: ToolResult[],
    trace: AgentTraceRecorder,
  ): Promise<void> {
    if (!/(delete|remove|删|删除|删掉)/i.test(message)) return;
    const search = results.find((result) => result.status === "success" && typeof result.data === "object" && result.data && "items" in result.data);
    const items = (search?.data as { items?: Array<{ id: string; title?: string }> } | undefined)?.items ?? [];
    if (items.length !== 1) return;
    const tool = this.tools.get("delete_experience");
    if (!tool) return;
    const pending = this.pendingActions.create({
      userId,
      sessionId,
      turnId,
      tool,
      toolArguments: { experienceId: items[0]!.id },
      title: `Delete ${items[0]!.title ?? "experience"}`,
      summary: `Please confirm deleting "${items[0]!.title ?? items[0]!.id}".`,
      affectedResources: [{ type: "experience", id: items[0]!.id, title: items[0]!.title }],
      preview: { before: items[0] },
    });
    trace.add({
      agentName: "experience_receiver",
      type: "confirmation_required",
      summary: "Confirmation required for delete_experience.",
      toolName: "delete_experience",
      status: "needs_input",
      completedAt: new Date().toISOString(),
      metadata: { pendingActionId: pending.id },
    });
    results.push({
      status: "needs_input",
      message: pending.summary,
      pendingActionId: pending.id,
      actionResult: { status: "needs_confirmation", actionType: "delete_experience", pendingActionId: pending.id },
    });
  }

  private async finish(
    userId: string,
    sessionId: string,
    turnId: string,
    context: AgentContext,
    existingWorkspace: CopilotWorkspace | null,
    input: {
      assistantText: string;
      toolResults: ToolResult[];
      trace: AgentTraceRecorder;
      pendingActions: unknown[];
      workspacePatch: Record<string, unknown>;
    },
  ): Promise<CopilotChatResponse> {
    input.trace.add({ agentName: "AgentOrchestrator", type: "final", summary: "Prepared user-visible response.", status: "success", completedAt: new Date().toISOString() });
    const now = new Date().toISOString();
    const assistantMessage: CopilotMessage = {
      id: `msg-${randomUUID()}`,
      sessionId,
      turnId,
      role: "assistant",
      content: input.assistantText,
      kind: input.toolResults.some((result) => result.actionResult?.status === "needs_confirmation") ? "clarifying_question" : "plain_text",
      createdAt: now,
    };
    const workspace = await this.saveWorkspace(userId, sessionId, existingWorkspace, input.workspacePatch, now);
    await this.deps.kernel.copilotServices.sessionService.saveMessage(userId, assistantMessage);
    await this.deps.kernel.copilotServices.sessionService.completeTurn(userId, turnId, assistantMessage.id);
    await this.deps.kernel.copilotServices.workspaceService.recordActivity(userId, {
      sessionId,
      type: "chat",
      title: "Copilot replied",
      metadata: { traceRunId: input.trace.trace.runId },
    });
    return {
      sessionId,
      turnId,
      assistantMessage,
      timeline: timelineFor(input.toolResults, now, turnId),
      workspace,
      nextActions: [],
      raw: {
        artifactIds: [],
        evidenceChainIds: [],
        critiqueItemIds: [],
        decisionIds: [],
        agentTrace: input.trace.trace,
        toolResults: input.toolResults,
        pendingActions: input.pendingActions,
        actionResults: input.toolResults
          .map((result) => result.actionResult)
          .filter((item): item is CopilotActionResult => item !== undefined && typeof item.status === "string"),
      },
    };
  }

  private async saveUserMessage(userId: string, sessionId: string, content: string): Promise<CopilotMessage> {
    const message: CopilotMessage = {
      id: `msg-${randomUUID()}`,
      sessionId,
      role: "user",
      content,
      kind: "plain_text",
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

function mergeWorkspacePatch(results: ToolResult[]): Record<string, unknown> {
  return results.reduce<Record<string, unknown>>((merged, result) => ({ ...merged, ...(result.workspacePatch ?? {}) }), {});
}

function assistantFromResults(results: ToolResult[], fallback: string): string {
  const messages = results.map((result) => result.message).filter((item): item is string => Boolean(item));
  if (messages.length > 0) return messages.join("\n");
  return fallback || "Done.";
}

function timelineFor(results: ToolResult[], now: string, turnId: string): ProductTimelineItem[] {
  if (results.length === 0) return [{ id: `tl-${turnId}-message`, type: "message_received", title: "Assistant replied", status: "completed", createdAt: now }];
  return results.map((result, index) => ({
    id: `tl-${turnId}-${index}`,
    type: result.actionResult?.status === "needs_confirmation" ? "warning" : "message_received",
    title: result.message ?? "Tool result",
    status: result.status === "failed" ? "failed" : "completed",
    createdAt: now,
  }));
}

function confirmationSummary(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "save_experience_from_text") return "Please confirm saving this experience to your library.";
  if (toolName === "update_experience") return "Please confirm updating this experience.";
  if (toolName === "delete_experience") return "Please confirm deleting this experience.";
  if (toolName === "export_resume") return "Please confirm creating this resume export.";
  return `Please confirm ${toolName}.`;
}

function affectedResourcesFor(toolName: string, args: Record<string, unknown>) {
  if (toolName.includes("experience")) return [{ type: "experience" as const, id: typeof args.experienceId === "string" ? args.experienceId : undefined }];
  if (toolName.includes("jd")) return [{ type: "jd" as const }];
  if (toolName.includes("resume")) return [{ type: "resume" as const, id: typeof args.resumeId === "string" ? args.resumeId : undefined }];
  if (toolName.includes("export")) return [{ type: "export" as const }];
  return [];
}

function previewFor(toolName: string, args: Record<string, unknown>) {
  if (toolName === "save_experience_from_text") return { after: { text: args.text } };
  if (toolName === "update_experience") return { after: args };
  if (toolName === "delete_experience") return { before: args };
  return undefined;
}
