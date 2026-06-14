import { ActiveAssetContextBuilder } from "../../copilot/ActiveAssetContextBuilder.js";
import { UserAssetContextBuilder } from "../../copilot/context/UserAssetContextBuilder.js";
import type { AgentContext } from "../runtime/AgentContext.js";
import { AgentLoopController } from "../runtime/AgentLoopController.js";
import { AgentMessageBus } from "../runtime/AgentMessageBus.js";
import type { RunState } from "../runtime/RunState.js";
import { AgentTraceRecorder } from "../runtime/AgentTrace.js";
import { ToolExecutor } from "../tools/ToolExecutor.js";
import { ContextBudgetManager } from "./ContextBudgetManager.js";
import type { ContextAssemblyInput, ContextAssemblyPipelineDeps } from "./ContextAssemblyInput.js";

export class ContextAssemblyPipeline {
  private readonly activeAssetContextBuilder: ActiveAssetContextBuilder;
  private readonly userAssetContextBuilder: UserAssetContextBuilder;
  private readonly budgetManager = new ContextBudgetManager();

  public constructor(private readonly deps: ContextAssemblyPipelineDeps) {
    this.activeAssetContextBuilder = new ActiveAssetContextBuilder(deps.kernel);
    this.userAssetContextBuilder = new UserAssetContextBuilder(deps.kernel);
  }

  public async assemble(input: ContextAssemblyInput): Promise<RunState> {
    const [workspace, recentMessages] = await Promise.all([
      this.deps.kernel.copilotServices.workspaceService.getWorkspace(input.ctx.user.id, input.sessionId),
      this.deps.kernel.copilotServices.sessionService.getRecentMessages(input.ctx.user.id, input.sessionId, 8),
    ]);
    const trace = new AgentTraceRecorder();
    const messageBus = new AgentMessageBus(trace.trace.runId, input.turnId);
    const loopController = new AgentLoopController();
    const activeAsset = await this.activeAssetContextBuilder.build({ userId: input.ctx.user.id, request: input.request, workspace });
    const userAsset = await this.userAssetContextBuilder.build({
      userId: input.ctx.user.id,
      workspace,
      clientState: input.request.clientState,
      activeAssetContext: activeAsset,
      productContext: input.productContext,
      userMessage: input.userMessage,
    });
    const context: AgentContext = {
      kernel: this.deps.kernel,
      requestContext: input.ctx,
      userId: input.ctx.user.id,
      sessionId: input.sessionId,
      turnId: input.turnId,
      userMessage: input.userMessage,
      recentMessages,
      workspace,
      clientState: input.request.clientState,
      activeAssetContext: activeAsset,
      userAssetContext: userAsset,
      productContext: input.productContext,
      availableTools: this.deps.tools.list(),
      trace: trace.trace,
      observations: [],
      agentMessages: [],
      loopState: loopController.state,
    };
    context.productContext = await this.applyCapabilityContextProviders(context);
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
      executor: new ToolExecutor(this.deps.tools, trace),
      workspace,
      messageBus,
      loopController,
      streamEmitter: input.streamEmitter,
    };
  }

  private async applyCapabilityContextProviders(context: AgentContext): Promise<Record<string, unknown>> {
    const providers = this.deps.capabilityRegistry.listContextProviders();
    if (providers.length === 0) return context.productContext;

    const settled = await Promise.allSettled(providers.map((provider) => provider.provide(context)));
    const provided: Record<string, unknown>[] = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        provided.push(result.value);
        return;
      }
      context.trace.steps.push({
        id: `capability-provider-failed-${index}`,
        agentName: "AgentOrchestrator",
        type: "reason",
        summary: "Capability context provider failed; continuing without provider output.",
        status: "failed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        metadata: {
          providerId: providerIdFor(providers[index]),
          index,
          reason: errorReason(result.reason),
        },
      });
    });
    const contextOutput = this.budgetManager.apply(Object.assign({}, ...provided));
    if (Object.keys(contextOutput).length === 0) return context.productContext;

    const existingCapabilities = isRecord(context.productContext.capabilities)
      ? context.productContext.capabilities
      : {};
    const existingContextOutput = isRecord(existingCapabilities.context)
      ? existingCapabilities.context
      : {};
    return {
      ...context.productContext,
      capabilities: {
        ...existingCapabilities,
        context: {
          ...existingContextOutput,
          ...contextOutput,
        },
      },
    };
  }
}

function providerIdFor(provider: unknown): string | undefined {
  if (!isRecord(provider)) return undefined;
  return typeof provider.id === "string" ? provider.id : undefined;
}

function errorReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
