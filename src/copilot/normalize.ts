import type { CopilotMessage, CopilotTurn, CopilotWorkspace } from "./types.js";
import { normalizeDraftContext } from "./context/DraftContext.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const VALID_MESSAGE_KINDS = [
  "plain_text",
  "resume_feedback",
  "variant_suggestion",
  "evidence_explanation",
  "decision_summary",
  "clarifying_question",
] as const;

const VALID_WORKSPACE_STATUSES = [
  "empty",
  "ready",
  "generating",
  "awaiting_user_decision",
  "accepted",
  "revision_needed",
] as const;

export function normalizeCopilotMessage(msg: unknown): CopilotMessage {
  if (!isRecord(msg)) {
    return {
      id: "",
      sessionId: "",
      role: "system",
      content: "",
      kind: "plain_text",
      createdAt: new Date().toISOString(),
    };
  }
  const kind = msg.kind;
  return {
    id: typeof msg.id === "string" ? msg.id : "",
    sessionId: typeof msg.sessionId === "string" ? msg.sessionId : "",
    turnId: msg.turnId != null && typeof msg.turnId === "string" ? msg.turnId : null,
    role:
      msg.role === "user" || msg.role === "assistant" || msg.role === "system"
        ? msg.role
        : "system",
    content: typeof msg.content === "string" ? msg.content : "",
    kind:
      typeof kind === "string" && (VALID_MESSAGE_KINDS as readonly string[]).includes(kind)
        ? (kind as CopilotMessage["kind"])
        : "plain_text",
    createdAt:
      typeof msg.createdAt === "string" ? msg.createdAt : new Date().toISOString(),
    metadata: isRecord(msg.metadata) ? (msg.metadata as CopilotMessage["metadata"]) : undefined,
  };
}

export function normalizeCopilotWorkspace(ws: unknown): CopilotWorkspace | null {
  if (!isRecord(ws)) return null;
  const variants = Array.isArray(ws.variants) ? (ws.variants as CopilotWorkspace["variants"]) : [];
  const status =
    typeof ws.status === "string" && (VALID_WORKSPACE_STATUSES as readonly string[]).includes(ws.status)
      ? (ws.status as CopilotWorkspace["status"])
      : "empty";
  return {
    id: typeof ws.id === "string" ? ws.id : "",
    sessionId: typeof ws.sessionId === "string" ? ws.sessionId : "",
    activeVariantId:
      typeof ws.activeVariantId === "string" ? ws.activeVariantId : null,
    activePanel:
      typeof ws.activePanel === "string"
        ? (ws.activePanel as CopilotWorkspace["activePanel"])
        : undefined,
    productGenerationId:
      typeof ws.productGenerationId === "string" ? ws.productGenerationId : null,
    jdId: typeof ws.jdId === "string" ? ws.jdId : null,
    resumeId: typeof ws.resumeId === "string" ? ws.resumeId : null,
    variants,
    experiences: Array.isArray(ws.experiences)
      ? (ws.experiences as CopilotWorkspace["experiences"])
      : undefined,
    jds: Array.isArray(ws.jds) ? (ws.jds as CopilotWorkspace["jds"]) : undefined,
    resumes: Array.isArray(ws.resumes)
      ? (ws.resumes as CopilotWorkspace["resumes"])
      : undefined,
    activeResume: isRecord(ws.activeResume)
      ? (ws.activeResume as CopilotWorkspace["activeResume"])
      : undefined,
    activeExportId:
      typeof ws.activeExportId === "string" ? ws.activeExportId : undefined,
    exportRecords: Array.isArray(ws.exportRecords)
      ? (ws.exportRecords as CopilotWorkspace["exportRecords"])
      : undefined,
    importCandidates: Array.isArray(ws.importCandidates)
      ? (ws.importCandidates as CopilotWorkspace["importCandidates"])
      : undefined,
    selectedEvidenceChainId:
      typeof ws.selectedEvidenceChainId === "string"
        ? ws.selectedEvidenceChainId
        : null,
    drafts: normalizeDraftContext(ws.drafts),
    handoffs: Array.isArray(ws.handoffs)
      ? (ws.handoffs as NonNullable<CopilotWorkspace["handoffs"]>).slice(-8)
      : undefined,
    currentTask: isRecord(ws.currentTask)
      ? (ws.currentTask as CopilotWorkspace["currentTask"])
      : undefined,
    suggestedTasks: Array.isArray(ws.suggestedTasks)
      ? (ws.suggestedTasks as CopilotWorkspace["suggestedTasks"])
      : undefined,
    jdProfile: isRecord(ws.jdProfile)
      ? (ws.jdProfile as CopilotWorkspace["jdProfile"])
      : undefined,
    workingSets: isRecord(ws.workingSets)
      ? (ws.workingSets as Record<string, unknown>)
      : undefined,
    active: isRecord(ws.active)
      ? (ws.active as CopilotWorkspace["active"])
      : undefined,
    status,
    summary: typeof ws.summary === "string" ? ws.summary : undefined,
    updatedAt:
      typeof ws.updatedAt === "string" ? ws.updatedAt : new Date().toISOString(),
  };
}

export function normalizeCopilotTurn(turn: unknown): CopilotTurn {
  if (!isRecord(turn)) {
    return {
      id: "",
      sessionId: "",
      userMessageId: "",
      status: "failed",
      createdAt: new Date().toISOString(),
    };
  }
  const status = turn.status;
  const validTurnStatuses = ["pending", "running", "completed", "failed"] as const;
  const completedAt = normalizeOptionalDateString(turn.completedAt);
  return {
    id: typeof turn.id === "string" ? turn.id : "",
    sessionId: typeof turn.sessionId === "string" ? turn.sessionId : "",
    userMessageId: typeof turn.userMessageId === "string" ? turn.userMessageId : "",
    assistantMessageId:
      turn.assistantMessageId != null && typeof turn.assistantMessageId === "string"
        ? turn.assistantMessageId
        : null,
    intent:
      turn.intent != null && typeof turn.intent === "string" ? turn.intent : null,
    status:
      typeof status === "string" && (validTurnStatuses as readonly string[]).includes(status)
        ? (status as CopilotTurn["status"])
        : "completed",
    createdAt:
      typeof turn.createdAt === "string" ? turn.createdAt : new Date().toISOString(),
    ...(completedAt ? { completedAt } : {}),
    error:
      turn.error != null && typeof turn.error === "string" ? turn.error : null,
  };
}

function normalizeOptionalDateString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return undefined;
}
