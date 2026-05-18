import { randomUUID } from "node:crypto";
import type {
  CopilotChatResponse,
  CopilotMessage,
  CopilotWorkspace,
  ProductAction,
  ProductTimelineItem,
  SuggestedPrompt,
} from "./types.js";
import type { AgentDecision } from "../agents/schema/AgentDecision.js";
import type { AgentToolResult } from "../agents/tools/AgentToolRegistry.js";

export type PresentAgentRunInput = {
  sessionId: string;
  turnId: string;
  decision: AgentDecision;
  toolResults: AgentToolResult[];
  workspace: CopilotWorkspace;
};

export class CopilotPresenter {
  public present(input: PresentAgentRunInput): CopilotChatResponse {
    const now = new Date().toISOString();
    const assistantMessage: CopilotMessage = {
      id: `msg-${randomUUID()}`,
      sessionId: input.sessionId,
      turnId: input.turnId,
      role: "assistant",
      content: composeAssistantMessage(input.decision, input.toolResults),
      kind: messageKind(input.decision, input.toolResults),
      createdAt: now,
    };
    const timeline = input.toolResults.flatMap((result) => result.timelineItems ?? []);
    const fallbackTimeline: ProductTimelineItem[] = [{
      id: `tl-${input.turnId}-message`,
      type: input.toolResults.some((result) => result.status === "failed") ? "warning" : "message_received",
      title: input.toolResults.some((result) => result.status === "failed") ? "Tool failed" : "Assistant replied",
      status: input.toolResults.some((result) => result.status === "failed") ? "failed" : "completed",
      createdAt: now,
    }];
    return {
      sessionId: input.sessionId,
      turnId: input.turnId,
      assistantMessage,
      timeline: timeline.length > 0 ? timeline : fallbackTimeline,
      workspace: { ...input.workspace, updatedAt: now },
      nextActions: mergeActions(input.toolResults),
      suggestedPrompts: mergeSuggestedPrompts(input.decision, input.toolResults),
      raw: mergeRawIds(input.toolResults),
    };
  }
}

function composeAssistantMessage(decision: AgentDecision, toolResults: AgentToolResult[]): string {
  const toolMessages = toolResults.map((result) => result.assistantMessage).filter((item): item is string => Boolean(item));
  if (toolMessages.length === 0) return decision.assistantMessage;
  if (!decision.assistantMessage.trim() || toolMessages.some((message) => message === decision.assistantMessage)) {
    return toolMessages.join("\n\n");
  }
  return [decision.assistantMessage, ...toolMessages].join("\n\n");
}

function messageKind(decision: AgentDecision, toolResults: AgentToolResult[]): CopilotMessage["kind"] {
  if (decision.mode === "ask_clarification" || toolResults.some((result) => result.status === "needs_input")) {
    return "clarifying_question";
  }
  if (toolResults.some((result) => result.timelineItems?.some((item) => item.type === "evidence_opened"))) {
    return "evidence_explanation";
  }
  if (toolResults.some((result) => result.timelineItems?.some((item) => item.type === "decision_recorded"))) {
    return "decision_summary";
  }
  if (toolResults.some((result) => result.workspacePatch?.activePanel === "resume_editor" || result.workspacePatch?.status === "accepted")) {
    return "decision_summary";
  }
  if (toolResults.some((result) => result.workspacePatch?.variants?.length)) {
    return "variant_suggestion";
  }
  return "plain_text";
}

function mergeActions(results: AgentToolResult[]): ProductAction[] {
  const actions = results.flatMap((result) => result.nextActions ?? []);
  const seen = new Set<string>();
  return actions.filter((action) => {
    if (seen.has(action.id)) return false;
    seen.add(action.id);
    return true;
  });
}

function mergeSuggestedPrompts(decision: AgentDecision, results: AgentToolResult[]): SuggestedPrompt[] | undefined {
  const prompts = [...(decision.suggestedPrompts ?? []), ...results.flatMap((result) => result.suggestedPrompts ?? [])];
  if (prompts.length === 0) return undefined;
  const seen = new Set<string>();
  return prompts.filter((prompt) => {
    const key = `${prompt.label}:${prompt.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeRawIds(results: AgentToolResult[]): CopilotChatResponse["raw"] {
  return {
    artifactIds: unique(results.flatMap((result) => result.rawIds?.artifactIds ?? [])),
    evidenceChainIds: unique(results.flatMap((result) => result.rawIds?.evidenceChainIds ?? [])),
    critiqueItemIds: unique(results.flatMap((result) => result.rawIds?.critiqueItemIds ?? [])),
    decisionIds: unique(results.flatMap((result) => result.rawIds?.decisionIds ?? [])),
  };
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
