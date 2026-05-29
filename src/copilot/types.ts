import type {
  ProductExperienceSummary,
  ProductImportCandidateSummary,
  ProductJDSummary,
  ProductResumeDetail,
  ProductResumeSummary,
} from "../product/types.js";
import type { AgentStreamEvent } from "../agent-core/runtime/AgentStreamEvent.js";
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
  type: "experience_list" | "experience_card" | "experience_detail" | "action_result";
  title?: string;
  data: Record<string, unknown>;
};

export type CopilotMessageMetadata = {
  productBlocks?: ProductBlock[];
  actionResult?: CopilotActionResult;
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
  | "save_experience_from_text"
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
