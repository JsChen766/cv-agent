import { randomUUID } from "node:crypto";
import type { ProductBlock, CopilotActionResult, ProductAction, CopilotMessageMetadata } from "../../copilot/types.js";
import type { ToolResult } from "../tools/ToolResult.js";
import type { PendingAction } from "../confirmation/PendingAction.js";
import type { AgentMessage, AgentMessageParticipant } from "../runtime/AgentMessage.js";
import type { CopilotLocale } from "../../copilot/locale.js";
import { sanitizeMetadataObject } from "../runtime/ProductBlockPresenter.js";
import type { AgentRoomEvent, AgentRoomAgentName, AgentRoomEventKind, SpecialInfoKind } from "./AgentRoomEvent.js";

/**
 * Projects existing Copilot response structures (ProductBlock, ToolResult,
 * actionResult, pending action, workspacePatch) into AgentRoomEvent[].
 *
 * Phase 1 strategy: pure projection, no database, no new persistence.
 * Events are added as an optional field alongside the existing response.
 */
export function projectAgentRoomEvents(input: {
  productBlocks?: ProductBlock[];
  toolResults?: ToolResult[];
  actionResult?: CopilotActionResult;
  pendingActionIds?: string[];
  pendingActions?: PendingAction[];
  workspacePatch?: Record<string, unknown>;
  sessionId?: string;
  turnId?: string;
  agentMessages?: AgentMessage[];
  locale?: CopilotLocale;
}): AgentRoomEvent[] {
  const now = new Date().toISOString();
  const locale = input.locale ?? "zh-CN";
  const events: AgentRoomEvent[] = [];

  // 1. Product blocks -> special_info events
  for (const block of input.productBlocks ?? []) {
    const event = projectBlock(block, input);
    if (event) events.push(event);
  }

  // 2. Tool results -> tool_result events
  for (const result of input.toolResults ?? []) {
    if (result.visibility === "internal") continue;
    events.push({
      id: `evt-${randomUUID()}`,
      sessionId: input.sessionId,
      turnId: input.turnId,
      agentName: "system",
      agentRoleLabel: "System",
      eventKind: result.status === "failed" ? "error" : "tool_result",
      visibility: result.status === "failed" ? "error_visible" : "visible",
      content: result.message ?? (result.status === "success" ? "Tool completed." : "Tool needs input."),
      relatedToolName: typeof result.actionResult?.actionType === "string" ? result.actionResult.actionType : undefined,
      createdAt: now,
    });
  }

  for (const msg of input.agentMessages ?? []) {
    if (msg.to !== "all" && msg.to !== "orchestrator") continue;
    const payload = isRecord(msg.payload) ? msg.payload : {};
    events.push({
      id: `evt-${randomUUID()}`,
      sessionId: input.sessionId,
      turnId: input.turnId,
      agentName: mapParticipantToAgentRoomName(msg.from),
      agentRoleLabel: agentLabel(msg.from, locale),
      eventKind: mapMessageTypeToEventKind(stringValue(payload.eventType) ?? msg.type),
      visibility: "visible",
      content: msg.content,
      relatedToolName: stringValue(payload.toolName),
      createdAt: msg.createdAt,
      metadata: Object.keys(payload).length > 0 ? payload : undefined,
    });
  }
  // 3. Pending actions -> decision_panel events
  for (const pendingAction of input.pendingActions ?? []) {
    const safePendingAction = sanitizePendingAction(pendingAction);
    events.push({
      id: `evt-${randomUUID()}`,
      sessionId: input.sessionId,
      turnId: input.turnId,
      agentName: agentNameForPendingAction(pendingAction.toolName),
      agentRoleLabel: agentLabel(agentNameForPendingAction(pendingAction.toolName), locale),
      eventKind: "pending_action",
      visibility: "visible",
      content: pendingAction.summary || "A pending action requires your confirmation.",
      specialInfo: {
        kind: "decision_panel",
        title: pendingAction.title,
        summary: pendingAction.summary,
        data: {
          pendingActionId: pendingAction.id,
          pendingAction: safePendingAction,
          action: safePendingAction,
        },
      },
      relatedToolName: pendingAction.toolName,
      createdAt: pendingAction.createdAt || now,
    });
  }
  for (const _paId of input.pendingActionIds ?? []) {
    if ((input.pendingActions ?? []).some((item) => item.id === _paId)) continue;
    events.push({
      id: `evt-${randomUUID()}`,
      sessionId: input.sessionId,
      turnId: input.turnId,
      agentName: "system",
      agentRoleLabel: "System",
      eventKind: "pending_action",
      visibility: "visible",
      content: "A pending action requires your confirmation.",
      specialInfo: {
        kind: "decision_panel",
        data: { pendingActionId: _paId },
      },
      createdAt: now,
    });
  }

  // 4. Workspace patch activePanel -> asset_capsule or system
  if (input.workspacePatch) {
    const activePanel = typeof input.workspacePatch.activePanel === "string"
      ? input.workspacePatch.activePanel
      : undefined;
    if (activePanel) {
      events.push({
        id: `evt-${randomUUID()}`,
        sessionId: input.sessionId,
        turnId: input.turnId,
        agentName: "system",
        agentRoleLabel: "System",
        eventKind: "special_info",
        visibility: "internal",
        content: `Workspace panel updated: ${activePanel}`,
        specialInfo: {
          kind: "asset_capsule",
          data: { activePanel },
          relatedResourceIds: {
            experienceIds: input.workspacePatch.experiences
              ? (input.workspacePatch.experiences as Array<Record<string, unknown>>).map((e) => e.id as string).filter(Boolean)
              : undefined,
          },
        },
        createdAt: now,
      });
    }
  }

  return events;
}

function mapMessageTypeToEventKind(type: string): AgentRoomEventKind {
  const map: Record<string, AgentRoomEventKind> = {
    routing: "system",
    announcement: "agent_text",
    tool_result: "tool_result",
    review_request: "system",
    observation: "tool_result",
    tool_call: "tool_call",
    revision_request: "system",
    response: "agent_text",
    critique: "agent_text",
    request: "system",
  };
  return map[type] || "system";
}

function mapParticipantToAgentRoomName(participant: AgentMessageParticipant): AgentRoomAgentName {
  if (
    participant === "frontdesk"
    || participant === "experience_receiver"
    || participant === "strategist"
    || participant === "architect"
    || participant === "critic"
  ) {
    return participant;
  }
  return "system";
}

const AGENT_LABELS: Record<AgentRoomAgentName, Record<CopilotLocale, string>> = {
  frontdesk: { "zh-CN": "前台接待 Agent", en: "Front Desk Agent" },
  experience_receiver: { "zh-CN": "经历编目员 Agent", en: "Experience Cataloger Agent" },
  strategist: { "zh-CN": "JD 分析师 Agent", en: "JD Analyst Agent" },
  architect: { "zh-CN": "简历改写 Agent", en: "Resume Architect Agent" },
  critic: { "zh-CN": "证据审查 Agent", en: "Evidence Reviewer Agent" },
  system: { "zh-CN": "系统", en: "System" },
};

function agentLabel(participant: AgentMessageParticipant | AgentRoomAgentName, locale: CopilotLocale): string {
  const agentName = participant === "all" || participant === "orchestrator"
    ? mapParticipantToAgentRoomName(participant)
    : participant;
  return AGENT_LABELS[agentName]?.[locale] ?? "Agent";
}

function agentNameForPendingAction(toolName: string): AgentRoomAgentName {
  if (toolName.includes("experience")) return "experience_receiver";
  if (toolName.includes("jd") || toolName.includes("match")) return "strategist";
  if (toolName.includes("resume") || toolName.includes("variant")) return "architect";
  return "system";
}

function sanitizePendingAction(action: PendingAction): Record<string, unknown> {
  return sanitizeMetadataObject({
    id: action.id,
    toolName: action.toolName,
    status: action.status,
    title: action.title,
    summary: action.summary,
    riskLevel: action.riskLevel,
    affectedResources: action.affectedResources,
    preview: action.preview,
    createdAt: action.createdAt,
    expiresAt: action.expiresAt,
  }) ?? { id: action.id };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function projectBlock(
  block: ProductBlock,
  _input: { sessionId?: string; turnId?: string },
): AgentRoomEvent | null {
  const now = new Date().toISOString();
  const blockToEvent = BLOCK_MAP[block.type];
  if (!blockToEvent) return null;

  return {
    id: `evt-${randomUUID()}`,
    agentName: blockToEvent.agentName,
    agentRoleLabel: blockToEvent.roleLabel,
    eventKind: "special_info",
    visibility: "visible",
    content: block.title ?? blockToEvent.defaultTitle,
    specialInfo: {
      kind: blockToEvent.specialKind,
      title: block.title ?? blockToEvent.defaultTitle,
      data: block.data,
      source: { blockType: block.type },
    },
    relatedResourceIds: blockToEvent.relatedIds,
    createdAt: now,
  };
}

type BlockProjection = {
  agentName: AgentRoomAgentName;
  roleLabel: string;
  specialKind: SpecialInfoKind;
  defaultTitle: string;
  relatedIds?: AgentRoomEvent["relatedResourceIds"];
};

const BLOCK_MAP: Record<string, BlockProjection> = {
  experience_match_results: {
    agentName: "strategist",
    roleLabel: "JD Analyst",
    specialKind: "match_matrix",
    defaultTitle: "JD Match Results",
  },
  experience_list: {
    agentName: "experience_receiver",
    roleLabel: "Experience Cataloger",
    specialKind: "asset_capsule",
    defaultTitle: "Experience Library",
  },
  experience_card: {
    agentName: "experience_receiver",
    roleLabel: "Experience Cataloger",
    specialKind: "asset_capsule",
    defaultTitle: "Experience Card",
  },
  experience_detail: {
    agentName: "experience_receiver",
    roleLabel: "Experience Cataloger",
    specialKind: "asset_capsule",
    defaultTitle: "Experience Detail",
  },
  experience_candidate_form: {
    agentName: "experience_receiver",
    roleLabel: "Experience Cataloger",
    specialKind: "experience_candidate_form",
    defaultTitle: "Experience candidates",
  },
  action_result: {
    agentName: "system",
    roleLabel: "System",
    specialKind: "decision_panel",
    defaultTitle: "Action Result",
  },
};

/**
 * Restore agentRoomEvents for a historical message.
 *
 * Phase 3 derived-on-read strategy:
 * 1. If metadata already has agentRoomEvents (new messages), return them.
 * 2. Otherwise, fallback-project from displaySnapshot (productBlocks etc.).
 * 3. IDs are deterministic based on messageId + index to avoid UI flicker.
 */
export function reprojectAgentRoomEvents(metadata: CopilotMessageMetadata | undefined, messageId?: string): AgentRoomEvent[] {
  if (!metadata) return [];

  // Path 1: already persisted (Phase 3+ messages)
  if (metadata.agentRoomEvents?.length) return metadata.agentRoomEvents;

  // Path 2: fallback from displaySnapshot (Phase 1-2 messages)
  const ds = metadata.displaySnapshot;
  if (!ds) return [];

  const events = projectAgentRoomEvents({
    productBlocks: ds.productBlocks,
    workspacePatch: ds.workspacePatch,
  });

  // Replace random UUIDs with deterministic IDs for stable history replay
  if (messageId) {
    const now = new Date().toISOString();
    return events.map((evt, i) => ({
      ...evt,
      id: `evt-history-${messageId}-${i}`,
      createdAt: now,
    }));
  }

  return events;
}
