import type {
  ProductExperienceSummary,
  ProductImportCandidateSummary,
  ProductJDSummary,
  ProductResumeDetail,
  ProductResumeSummary,
} from "../product/types.js";
import type { AgentStreamEvent } from "../agent-core/runtime/AgentStreamEvent.js";
import type { AgentRoomEvent } from "../agent-core/events/AgentRoomEvent.js";
import type { DraftContext } from "./context/DraftContext.js";
import type { FrontDeskHandoff } from "./handoff/FrontDeskHandoff.js";
import type { JDProfile } from "./profile/JDProfile.js";
import type { CopilotTask } from "./tasks/CopilotTask.js";

export type CopilotSession = {
  id: string;
  userId: string;
  title?: string | null;
  targetRole?: string | null;
  resumeText?: string | null;
  jdText?: string | null;
  currentWorkspaceId?: string | null;
  status: "active" | "archived" | "deleted";
  resumeIngested: boolean;
  resumeDocumentIds?: string[];
  resumeArtifactIds?: string[];
  createdAt: string;
  updatedAt: string;
  // ── Backend-derived display fields (see SessionDisplayProjector). ────
  // The frontend renders these directly. It does NOT infer titles from
  // message bodies or run keyword heuristics. If the API leaves these
  // unset for some legacy code path, they are simply absent — never
  // backfilled on the client.
  displayTitle?: string | null;
  displaySubtitle?: string | null;
  sessionType?: string | null;
  displayStatus?: string | null;
};

export type CopilotTurn = {
  id: string;
  sessionId: string;
  userMessageId: string;
  assistantMessageId?: string | null;
  intent?: string | null;
  status: "pending" | "running" | "completed" | "failed";
  createdAt: string;
  completedAt?: string | null;
  error?: string | null;
};

export type ProductBlock = {
  type: "experience_list" | "experience_card" | "experience_detail" | "experience_candidate_form" | "jd_analysis_result" | "action_result" | "experience_match_results" | "jd_match_results";
  title?: string;
  data: Record<string, unknown>;
};

export type CopilotMessageAttachment = {
  id?: string;
  fileId?: string;
  originalName: string;
  mimeType?: string;
  size?: number;
  kind?: "resume_upload" | "file";
};

export type CopilotMessageMetadata = {
  attachments?: CopilotMessageAttachment[];
  productBlocks?: ProductBlock[];
  actionResult?: CopilotActionResult;
  /** Full workspace snapshot at this assistant turn for high-fidelity history restore. */
  workspace?: CopilotWorkspace;
  workspaceSnapshot?: {
    activePanel?: CopilotWorkspace["activePanel"];
    active?: CopilotWorkspace["active"];
    productGenerationId?: string | null;
    jdId?: string | null;
    resumeId?: string | null;
    activeVariantId?: string | null;
    variantCount?: number;
    experienceCount?: number;
  };
  relatedResourceIds?: {
    experienceIds?: string[];
    jdIds?: string[];
    resumeIds?: string[];
    generationIds?: string[];
  };
  /**
   * Full display snapshot for restoring history cards without frontend cache.
   * Populated by finishRun on every assistant message.
   * Old messages without this field only render plain text (degraded mode).
   */
  displaySnapshot?: CopilotMessageDisplaySnapshot;
  /** AgentRoomEvents for agent group chat history restore (D-02 Phase 3). */
  agentRoomEvents?: import("../agent-core/events/AgentRoomEvent.js").AgentRoomEvent[];
};

/**
 * Complete renderable snapshot persisted with every assistant message
 * so the frontend can restore card UI from history without runtime state.
 */
export type CopilotMessageDisplaySnapshot = {
  /** Pending actions visible at the time this message was created. */
  pendingActions?: DisplayPendingAction[];
  /** Tool results that generated frontend-visible cards. */
  toolResults?: DisplayToolResult[];
  /** Persisted product blocks for deterministic history restore. */
  productBlocks?: ProductBlock[];
  /** Workspace patch applied by this turn. */
  workspacePatch?: Record<string, unknown>;
  /** AgentRoomEvents saved at message creation time for history restore. */
  agentRoomEvents?: import("../agent-core/events/AgentRoomEvent.js").AgentRoomEvent[];
};

export type DisplayPendingAction = {
  id: string;
  toolName: string;
  title: string;
  summary: string;
  riskLevel: string;
  /** Current status. After confirm/cancel, this is updated to executed/cancelled. */
  status: "pending" | "confirmed" | "executed" | "cancelled" | "expired" | "failed";
  preview?: unknown;
  createdAt: string;
};

export type DisplayToolResult = {
  status: string;
  message?: string;
  visibility?: string;
  actionResult?: {
    actionType?: string;
    status: string;
    message?: string;
    reason?: string;
    pendingActionId?: string;
    experienceId?: string;
    variantId?: string;
    revisionSuggestion?: CopilotActionResult["revisionSuggestion"];
    metadata?: Record<string, unknown>;
  };
  data?: unknown;
  workspacePatch?: Record<string, unknown>;
};

export type CopilotMessage = {
  id: string;
  sessionId: string;
  turnId?: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  kind:
    | "plain_text"
    | "resume_feedback"
    | "variant_suggestion"
    | "evidence_explanation"
    | "decision_summary"
    | "clarifying_question";
  createdAt: string;
  metadata?: CopilotMessageMetadata;
};

export type CopilotWorkspace = {
  id: string;
  sessionId: string;
  activeVariantId?: string | null;
  activePanel?: "variants" | "experience_library" | "resume_history" | "resume_editor" | "jd_library" | "import_candidates";
  productGenerationId?: string | null;
  jdId?: string | null;
  resumeId?: string | null;
  variants: ProductVariant[];
  experiences?: ProductExperienceSummary[];
  jds?: ProductJDSummary[];
  resumes?: ProductResumeSummary[];
  activeResume?: ProductResumeDetail;
  activeExportId?: string;
  exportRecords?: Array<{
    id: string;
    resumeId: string;
    format: string;
    status: string;
    jobId?: string;
    createdAt?: string;
  }>;
  importCandidates?: ProductImportCandidateSummary[];
  selectedEvidenceChainId?: string | null;
  drafts?: DraftContext;
  handoffs?: FrontDeskHandoff[];
  currentTask?: CopilotTask;
  suggestedTasks?: CopilotTask[];
  jdProfile?: JDProfile;
  analysisReport?: unknown;
  editorialCriticReview?: unknown;
  criticPatchSuggestions?: unknown;
  resumeChangeSet?: unknown;
  resumePreviewSnapshots?: unknown;
  resumeDocumentDraft?: unknown;
  workingSets?: Record<string, unknown>;
  active?: {
    jdId?: string;
    jdDraftId?: string;
    experienceId?: string;
    experienceDraftId?: string;
    resumeId?: string;
    resumeItemId?: string;
    variantId?: string;
  };
  status:
    | "empty"
    | "ready"
    | "generating"
    | "awaiting_user_decision"
    | "accepted"
    | "revision_needed";
  summary?: string;
  updatedAt: string;
};

export type ProductVariant = {
  id: string;
  artifactId: string | null;
  title: string;
  content: string;
  role: "recommended" | "alternative" | "safe" | "quantified" | "experimental";
  status: "ready" | "needs_confirmation" | "unsafe" | "accepted" | "rejected";
  score: {
    overall?: number;
    relevance?: number;
    clarity?: number;
    evidenceStrength?: number;
    quantifiedImpact?: number;
  };
  badges: Array<{
    label: string;
    tone: "neutral" | "positive" | "warning" | "danger";
  }>;
  reason: string;
  evidenceSummary: {
    coverageLabel: string;
    items: Array<{
      id: string;
      title: string;
      quote?: string;
      explanation: string;
      confidence?: number;
    }>;
  };
  riskSummary: {
    level: string;
    unsupportedClaims: string[];
    missingEvidence: string[];
    warnings: string[];
  };
  missingInfo: string[];
  sourceExperienceIds: string[];
  sourceEvidenceIds: string[];
  actions: ProductAction[];
  raw: Record<string, unknown>;
  createdAt: string;
  // ── Product-level display metadata (mirrors ProductGeneratedVariant). ──
  // Backend-generated; the frontend never infers these.
  variantName?: string;
  summary?: string;
  scenario?: string;
  advantages?: string[];
  risks?: string[];
  recommended?: boolean;
  rank?: number;
  // Backward-compat aliases for migration
  /** @deprecated use content */
  after?: string;
  /** @deprecated use role */
  subtitle?: string | null;
};

export type ProductActionType =
  | "accept"
  | "reject"
  | "prefer"
  | "confirm_metric"
  | "revise_more_conservative"
  | "revise_more_quantified"
  | "show_evidence"
  | "explain_choice"
  | "match_experience"
  | "open_inspector"
  | "list_experiences"
  | "search_experiences"
  | "get_experience"
  | "analyze_jd"
  | "save_experience_from_text"
  | "save_experience_candidate"
  | "reject_experience_candidate"
  | "acceptImportCandidate"
  | "rejectImportCandidate"
  | "accept_import_candidate"
  | "reject_import_candidate"
  | "save_jd_from_text"
  | "update_experience"
  | "generate_from_jd"
  | "optimize_resume_item"
  | "rewrite_experience"
  | "export_resume";

export type ProductAction = {
  id: string;
  type: ProductActionType;
  label: string;
  description?: string;
  variantId?: string;
  payload?: Record<string, unknown>;
  primary: boolean;
  inputSchema?: {
    fields: Array<{
      key: string;
      label: string;
      type: "text" | "number" | "textarea";
      placeholder?: string;
      required?: boolean;
    }>;
  };
  // Backward-compat aliases
  /** @deprecated use inputSchema */
  requiresInput?: boolean;
  /** @deprecated use inputSchema.fields[0].placeholder */
  inputPlaceholder?: string;
};

export type SuggestedPrompt = {
  label: string;
  message: string;
};

export type CopilotClientState = {
  locale?: string;
  mainMode?: string;
  activeSessionId?: string;
  activeJDId?: string;
  activeResumeId?: string;
  activeExperienceId?: string;
  activeVariantId?: string;
  activeResumeItemId?: string;
  activeImportJobId?: string;
  activeCandidateIds?: string[];
  selectedText?: string;
  selectedSection?: string;
  visibleArtifactTypes?: string[];
  visibleArtifactIds?: string[];
  intentSource?: "composer" | "sidebar" | "artifact_action" | "asset_detail" | "system";
  sourceComponent?: string;
  resumeUpload?: {
    fileId: string;
    originalName?: string;
    mimeType?: string;
    size?: number;
    source?: string;
  };
  activeFileId?: string;
  resumeFileId?: string;
  uploadedFileId?: string;
  [key: string]: unknown;
};

export type ProductTimelineItem = {
  id: string;
  type:
    | "message_received"
    | "resume_ingested"
    | "jd_analyzed"
    | "variants_generated"
    | "critique_completed"
    | "revision_completed"
    | "export_created"
    | "decision_recorded"
    | "evidence_opened"
    | "warning";
  title: string;
  description?: string;
  status: "pending" | "running" | "completed" | "failed";
  createdAt: string;
  relatedVariantId?: string;
  relatedExportId?: string;
};

export type CopilotActionResultStatus = "success" | "needs_input" | "needs_confirmation" | "failed";

export type CopilotActionResult = {
  actionType?: string;
  status: CopilotActionResultStatus;
  message?: string;
  reason?: string;
  pendingActionId?: string;
  missingInputs?: string[];
  exportRecord?: {
    id: string;
    resumeId?: string;
    format?: string;
    status?: string;
    jobId?: string;
    createdAt?: string;
  };
  revisionSuggestion?: {
    kind: "resume_item" | "experience" | "variant";
    sourceId?: string;
    sourceTextPreview?: string;
    rewrittenText?: string;
    usedModel?: boolean;
    /** Per-change annotations from LLM rewrite (rewording, quantification, etc.). Always an array — empty when no changes detected. */
    changes?: Array<{
      type: "rewording" | "restructuring" | "quantification" | "trimming" | "expansion" | "translation" | "other";
      description: string;
      original?: string;
      rewritten?: string;
    }>;
  };
  evidenceId?: string;
  variantId?: string;
  metadata?: Record<string, unknown>;
};

export type CopilotChatRequest = {
  sessionId?: string;
  message: string;
  resumeText?: string;
  jdText?: string;
  targetRole?: string;
  clientState?: CopilotClientState;
};

export type CopilotChatResponse = {
  sessionId: string;
  turnId: string;
  assistantMessage: CopilotMessage;
  timeline: ProductTimelineItem[];
  workspace: CopilotWorkspace;
  nextActions: ProductAction[];
  suggestedPrompts?: SuggestedPrompt[];
  /** Phase 1: optional AgentRoomEvent stream for "agent group chat" frontend */
  agentRoomEvents?: AgentRoomEvent[];
  raw: CopilotRawSection;
};

export type CopilotActionRequest = {
  sessionId: string;
  turnId?: string;
  action: {
    type: ProductActionType;
    variantId?: string;
    payload?: Record<string, unknown>;
  };
  clientState?: CopilotClientState;
};

export type CopilotStreamEvent = AgentStreamEvent;

export type CopilotRawSection = {
  artifactIds: string[];
  evidenceChainIds: string[];
  critiqueItemIds: string[];
  decisionIds: string[];
  agentTrace?: unknown;
  toolResults?: unknown[];
  pendingActions?: unknown[];
  metadata?: Record<string, unknown>;
  exportId?: string;
  jobId?: string;
  resumeId?: string;
  format?: string;
  actionResults?: CopilotActionResult[];
  primaryActionResult?: CopilotActionResult;
};
