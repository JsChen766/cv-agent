import { randomUUID } from "node:crypto";
import type { ToolResult } from "../tools/ToolResult.js";
import { sanitizeMetadataObject } from "../runtime/ProductBlockPresenter.js";
import type { AgentRoomEvent } from "./AgentRoomEvent.js";

export function projectResumeWorkflowEvents(input: {
  result: ToolResult;
  sessionId?: string;
  turnId?: string;
  now: string;
}): AgentRoomEvent[] {
  const data = isRecord(input.result.data) ? input.result.data : undefined;
  const actionResult = isRecord(input.result.actionResult) ? input.result.actionResult : undefined;
  const metadata = actionResult && isRecord(actionResult.metadata) ? actionResult.metadata : undefined;
  const workflowStatus = readWorkflowStatus(data?.workflowStatus) ?? readWorkflowStatus(metadata?.workflowStatus);
  if (!workflowStatus) return [];

  return [{
    id: `evt-${randomUUID()}`,
    sessionId: input.sessionId,
    turnId: input.turnId,
    agentName: "architect",
    agentRoleLabel: "Resume Architect Agent",
    eventKind: "special_info",
    visibility: workflowStatus.status === "failed" ? "error_visible" : "visible",
    content: "Resume optimization workflow",
    relatedToolName: typeof actionResult?.actionType === "string" ? actionResult.actionType : undefined,
    createdAt: input.now,
    specialInfo: {
      kind: "agent_activity_timeline",
      title: "Resume optimization workflow",
      summary: workflowStatus.failureReason ?? `Current stage: ${workflowStatus.currentStage}`,
      data: sanitizeMetadataObject({
        workflowStatus,
        runId: workflowStatus.runId,
        status: workflowStatus.status,
        currentStage: workflowStatus.currentStage,
        stages: workflowStatus.stages,
        events: workflowStatus.events,
        nextAction: workflowStatus.nextAction,
      }),
      relatedResourceIds: {
        jdIds: workflowStatus.jdId ? [workflowStatus.jdId] : undefined,
        generationIds: workflowStatus.generationId ? [workflowStatus.generationId] : undefined,
      },
      actions: workflowStatus.nextAction
        ? [{
            id: `workflow-action-${workflowStatus.currentStage}`,
            type: workflowStatus.nextAction.type,
            label: workflowStatus.nextAction.label,
            payload: workflowStatus.nextAction.payload,
          }]
        : undefined,
      source: {
        toolName: typeof actionResult?.actionType === "string" ? actionResult.actionType : undefined,
      },
    },
    metadata: {
      runId: workflowStatus.runId,
      currentStage: workflowStatus.currentStage,
      status: workflowStatus.status,
    },
  }];
}

function readWorkflowStatus(value: unknown): WorkflowStatusLike | undefined {
  if (!isRecord(value)) return undefined;
  if (value.schemaVersion !== 1) return undefined;
  if (typeof value.runId !== "string") return undefined;
  if (!Array.isArray(value.stages) || !Array.isArray(value.events)) return undefined;
  return value as WorkflowStatusLike;
}

type WorkflowStatusLike = {
  schemaVersion: 1;
  runId: string;
  status: string;
  currentStage: string;
  stages: unknown[];
  events: unknown[];
  jdId?: string;
  generationId?: string;
  failureReason?: string;
  nextAction?: {
    type: string;
    label: string;
    payload?: Record<string, unknown>;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
