import type {
  CopilotActionResult,
  CopilotMessageMetadata,
  CopilotWorkspace,
  DisplayPendingAction,
  ProductBlock,
} from "../../copilot/types.js";
import type { AgentRoomEvent } from "../events/AgentRoomEvent.js";
import type { PendingAction } from "../confirmation/PendingAction.js";
import type { ToolResult } from "../tools/ToolResult.js";
import { sanitizeMetadataObject } from "./ProductBlockPresenter.js";
import {
  buildRelatedResourceIds,
  buildWorkspaceForHistory,
  buildWorkspaceSnapshot,
  hasRelatedResourceIds,
} from "./WorkspaceProjector.js";

export type AssistantMessageProjectionInput = {
  toolResults: ToolResult[];
  workspace: CopilotWorkspace | null;
  workspacePatch: Record<string, unknown>;
  pendingActions?: PendingAction[];
  productBlocks: ProductBlock[];
  agentRoomEvents?: AgentRoomEvent[];
};

export class AssistantMessageProjector {
  public buildMetadata(input: AssistantMessageProjectionInput): CopilotMessageMetadata {
    const actionResult = sanitizeActionResultForMetadata(primaryActionResult(input.toolResults));
    const workspaceForHistory = buildWorkspaceForHistory(input.workspace, input.workspacePatch);
    const workspaceSnapshot = buildWorkspaceSnapshot(input.workspace, input.workspacePatch);
    const relatedResourceIds = buildRelatedResourceIds(input.toolResults, input.workspace);
    const pendingActions = input.pendingActions ?? [];
    const displaySnapshot = buildDisplaySnapshot(input.toolResults, pendingActions, input.workspacePatch, input.productBlocks);

    return {
      ...(input.productBlocks.length > 0 ? { productBlocks: input.productBlocks } : {}),
      ...(actionResult ? { actionResult } : {}),
      ...(workspaceForHistory ? { workspace: workspaceForHistory } : {}),
      ...(workspaceSnapshot ? { workspaceSnapshot } : {}),
      ...(hasRelatedResourceIds(relatedResourceIds) ? { relatedResourceIds } : {}),
      ...(displaySnapshot ? { displaySnapshot } : {}),
      ...(input.agentRoomEvents?.length ? { agentRoomEvents: input.agentRoomEvents } : {}),
    };
  }
}

function buildDisplaySnapshot(
  toolResults: ToolResult[],
  pendingActions: PendingAction[],
  workspacePatch: Record<string, unknown>,
  productBlocks: ProductBlock[],
): CopilotMessageMetadata["displaySnapshot"] {
  const hasPending = pendingActions.length > 0;
  const hasToolResults = toolResults.length > 0;
  if (!hasPending && !hasToolResults) return undefined;

  const snapshot: NonNullable<CopilotMessageMetadata["displaySnapshot"]> = {};

  if (hasPending) {
    snapshot.pendingActions = pendingActions.map((pa) => ({
      id: pa.id,
      toolName: pa.toolName,
      title: pa.title,
      summary: pa.summary,
      riskLevel: pa.riskLevel as string,
      status: pa.status as DisplayPendingAction["status"],
      preview: pa.preview,
      createdAt: pa.createdAt,
    }));
  }

  if (hasToolResults) {
    snapshot.toolResults = toolResults
      .filter((tr) => tr.visibility !== "internal")
      .map((tr) => ({
        status: tr.status,
        message: tr.message,
        visibility: tr.visibility,
        actionResult: tr.actionResult ? {
          actionType: typeof tr.actionResult.actionType === "string" ? tr.actionResult.actionType : undefined,
          status: typeof tr.actionResult.status === "string" ? tr.actionResult.status : "success",
          message: typeof tr.actionResult.message === "string" ? tr.actionResult.message : undefined,
          reason: typeof tr.actionResult.reason === "string" ? tr.actionResult.reason : undefined,
          pendingActionId: typeof tr.actionResult.pendingActionId === "string" ? tr.actionResult.pendingActionId : undefined,
          experienceId: typeof tr.actionResult.experienceId === "string" ? tr.actionResult.experienceId : undefined,
          variantId: typeof tr.actionResult.variantId === "string" ? tr.actionResult.variantId : undefined,
          revisionSuggestion: (tr.actionResult.revisionSuggestion ?? undefined) as CopilotActionResult["revisionSuggestion"],
          metadata: isRecord(tr.actionResult.metadata) ? tr.actionResult.metadata as Record<string, unknown> : undefined,
        } : undefined,
        data: tr.data,
        workspacePatch: tr.workspacePatch,
      }));
  }

  if (Object.keys(workspacePatch).length > 0) {
    snapshot.workspacePatch = workspacePatch;
  }

  if (productBlocks.length > 0) {
    snapshot.productBlocks = productBlocks;
  }

  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

function primaryActionResult(toolResults: ToolResult[]): CopilotActionResult | undefined {
  const actionResults = toolResults
    .map((result) => result.actionResult)
    .filter((item): item is CopilotActionResult => item !== undefined && typeof item.status === "string");
  return actionResults.at(-1);
}

function sanitizeActionResultForMetadata(result: CopilotActionResult | undefined): CopilotActionResult | undefined {
  if (!result) return undefined;
  const metadata = sanitizeMetadataObject(result.metadata);
  return {
    actionType: result.actionType,
    status: result.status,
    message: result.message,
    reason: result.reason,
    pendingActionId: result.pendingActionId,
    missingInputs: result.missingInputs,
    exportRecord: result.exportRecord,
    revisionSuggestion: result.revisionSuggestion,
    evidenceId: result.evidenceId,
    variantId: result.variantId,
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
