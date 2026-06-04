import { randomUUID } from "node:crypto";
import type { ProductBlock, CopilotActionResult, ProductAction, CopilotMessageMetadata } from "../../copilot/types.js";
import type { ToolResult } from "../tools/ToolResult.js";
import type { AgentRoomEvent, AgentRoomAgentName, SpecialInfoKind } from "./AgentRoomEvent.js";

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
  workspacePatch?: Record<string, unknown>;
  sessionId?: string;
  turnId?: string;
}): AgentRoomEvent[] {
  const now = new Date().toISOString();
  const events: AgentRoomEvent[] = [];

  // 1. Product blocks → special_info events
  for (const block of input.productBlocks ?? []) {
    const event = projectBlock(block, input);
    if (event) events.push(event);
  }

  // 2. Tool results → tool_result events
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

  // 3. Pending actions → decision_panel events
  for (const _paId of input.pendingActionIds ?? []) {
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

  // 4. Workspace patch activePanel → asset_capsule or system
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
