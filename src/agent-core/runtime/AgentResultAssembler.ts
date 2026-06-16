import type { FrontDeskHandoff } from "../../copilot/handoff/FrontDeskHandoff.js";
import type { CopilotLocale } from "../../copilot/locale.js";
import { ResponseComposer } from "../../copilot/response/ResponseComposer.js";
import type { NarratorService } from "../../copilot/response/NarratorService.js";
import { isBlockedToolLog } from "../../copilot/response/ProductReplyTemplates.js";
import type {
  CopilotActionResult,
  CopilotChatResponse,
  CopilotMessage,
  CopilotWorkspace,
  ProductAction,
  ProductTimelineItem,
} from "../../copilot/types.js";
import { projectAgentRoomEvents } from "../events/AgentRoomEventProjector.js";
import type { AgentRoomEvent } from "../events/AgentRoomEvent.js";
import type { PendingAction } from "../confirmation/PendingAction.js";
import type { ToolResult } from "../tools/ToolResult.js";
import type { CriticReview } from "../validation/AgentOutputSchemas.js";
import { buildProductBlocks } from "./ProductBlockPresenter.js";
import type { RunState } from "./RunState.js";
import { AssistantMessageProjector } from "./AssistantMessageProjector.js";

export type AgentResultAssemblyInput = {
  run: RunState;
  locale: CopilotLocale;
  assistantText: string;
  toolResults: ToolResult[];
  pendingActions: PendingAction[];
  workspacePatch: Record<string, unknown>;
  criticReview?: CriticReview;
  invalidConfirmation: boolean;
  text: {
    done: string;
    productIntro: string;
    invalidConfirmation: string;
  };
};

export type AgentResultAssembly = {
  now: string;
  assistantText: string;
  toolResults: ToolResult[];
  pendingActions: PendingAction[];
  workspacePatch: Record<string, unknown>;
  nextActions: ProductAction[];
  agentRoomEvents?: AgentRoomEvent[];
  assistantMessageMetadata: CopilotMessage["metadata"];
  timeline: ProductTimelineItem[];
  rawMetadata: NonNullable<CopilotChatResponse["raw"]>["metadata"];
  actionResults: CopilotActionResult[];
};

export type AgentResultAssemblerDeps = {
  narrator?: NarratorService;
};

export class AgentResultAssembler {
  private readonly responseComposer: ResponseComposer;

  public constructor(
    private readonly assistantMessageProjector: AssistantMessageProjector = new AssistantMessageProjector(),
    deps: AgentResultAssemblerDeps = {},
  ) {
    this.responseComposer = new ResponseComposer({ narrator: deps.narrator });
  }

  public async assemble(input: AgentResultAssemblyInput): Promise<AgentResultAssembly> {
    const now = new Date().toISOString();
    const composed = await this.responseComposer.composeAsync({
      locale: input.locale,
      userMessage: input.run.context.userMessage,
      frontDeskHandoff: input.run.context.productContext.frontDeskHandoff as FrontDeskHandoff | undefined,
      workspace: input.run.workspace,
      toolResults: input.toolResults,
      pendingActions: input.pendingActions,
      criticReview: input.criticReview,
      currentTask: input.run.workspace?.currentTask,
      suggestedTasks: input.run.workspace?.suggestedTasks,
      context: input.run.context,
      fallbackText: input.assistantText,
    });
    const isGenericResponse = input.invalidConfirmation
      ? false
      : composed.assistantText === input.text.done || composed.assistantText === input.text.productIntro;
    let finalAssistantText = composed.assistantText;
    if (
      isGenericResponse
      && input.assistantText
      && input.assistantText.trim()
      && input.assistantText !== composed.assistantText
      && !isBlockedToolLog(input.assistantText)
    ) {
      finalAssistantText = input.assistantText;
    }
    const assistantText = input.invalidConfirmation ? input.text.invalidConfirmation : finalAssistantText;
    const workspacePatch = input.invalidConfirmation ? {} : input.workspacePatch;
    const productBlocks = buildProductBlocks(input.toolResults);
    const agentRoomEvents = projectAgentRoomEvents({
      productBlocks,
      toolResults: input.toolResults,
      pendingActionIds: input.pendingActions.map((pa) => pa.id),
      pendingActions: input.pendingActions,
      workspacePatch,
      sessionId: input.run.context.sessionId,
      turnId: input.run.context.turnId,
      agentMessages: input.run.context.agentMessages,
    });
    const assistantMessageMetadata = this.assistantMessageProjector.buildMetadata({
      toolResults: input.toolResults,
      workspace: input.run.workspace,
      workspacePatch,
      pendingActions: input.pendingActions,
      productBlocks,
      agentRoomEvents: agentRoomEvents.length > 0 ? agentRoomEvents : undefined,
    });

    return {
      now,
      assistantText,
      toolResults: input.toolResults,
      pendingActions: input.pendingActions,
      workspacePatch,
      nextActions: composed.nextActions ?? [],
      agentRoomEvents: agentRoomEvents.length > 0 ? agentRoomEvents : undefined,
      assistantMessageMetadata,
      timeline: timelineFor(input.toolResults, now, input.run.context.turnId),
      rawMetadata: {
        loop: input.run.context.loopState,
        observations: input.run.context.observations ?? [],
        agentMessages: input.run.context.agentMessages ?? [],
        criticReview: input.criticReview,
        responseComposer: {
          used: true,
          systemNotices: composed.systemNotices,
        },
      },
      actionResults: input.toolResults
        .map((result) => result.actionResult)
        .filter((item): item is CopilotActionResult => item !== undefined && typeof item.status === "string"),
    };
  }

  public buildResponse(input: {
    assembly: AgentResultAssembly;
    sessionId: string;
    turnId: string;
    assistantMessage: CopilotMessage;
    workspace: CopilotWorkspace;
    trace: CopilotChatResponse["raw"]["agentTrace"];
  }): CopilotChatResponse {
    return {
      sessionId: input.sessionId,
      turnId: input.turnId,
      assistantMessage: input.assistantMessage,
      timeline: input.assembly.timeline,
      workspace: input.workspace,
      nextActions: input.assembly.nextActions,
      agentRoomEvents: input.assembly.agentRoomEvents,
      raw: {
        artifactIds: [],
        evidenceChainIds: [],
        critiqueItemIds: [],
        decisionIds: [],
        agentTrace: input.trace,
        toolResults: input.assembly.toolResults,
        pendingActions: input.assembly.pendingActions,
        metadata: input.assembly.rawMetadata,
        actionResults: input.assembly.actionResults,
      },
    };
  }
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
