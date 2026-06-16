export type ApiSuccess<T> = {
  ok: true;
  data: T;
  meta?: Record<string, unknown>;
};

export type ApiFailure = {
  ok: false;
  error?: {
    code?: string;
    message?: string;
  };
  meta?: Record<string, unknown>;
};

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

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
};

export type SuggestedPrompt = {
  label: string;
  message: string;
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

export type CopilotActionResultStatus = "success" | "needs_input" | "failed";

export type CopilotActionResult = {
  actionType?: string;
  status: CopilotActionResultStatus;
  message?: string;
  reason?: string;
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
  raw?: {
    artifactId?: string;
    critiqueVerdict?: string | null;
    enhancementStatus?: string | null;
  };
  createdAt: string;
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
  status: "empty" | "ready" | "generating" | "awaiting_user_decision" | "accepted" | "revision_needed";
  summary?: string;
  updatedAt: string;
};

export type ProductExperienceSummary = {
  id: string;
  category: string;
  title: string;
  organization?: string;
  role?: string;
  status: string;
  currentRevisionId?: string;
  createdAt: string;
  updatedAt: string;
  content?: string;
};

export type ProductJDSummary = {
  id: string;
  title: string;
  company?: string;
  targetRole?: string;
  createdAt: string;
  updatedAt: string;
};

export type ProductResumeSummary = {
  id: string;
  title: string;
  targetRole?: string;
  jdId?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type ProductResumeDetail = ProductResumeSummary & {
  items: Array<{ id: string; title: string; contentSnapshot: string }>;
};

export type ProductImportCandidateSummary = {
  id: string;
  jobId: string;
  title: string;
  category: string;
  organization?: string;
  role?: string;
  content: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type CopilotChatInput = {
  sessionId?: string;
  message: string;
  resumeText?: string;
  jdText?: string;
  targetRole?: string;
  clientState?: {
    activeVariantId?: string;
    selectedSection?: string;
    locale?: string;
  };
};

export type CopilotActionInput = {
  sessionId: string;
  turnId?: string;
  action: {
    type: ProductActionType;
    variantId?: string;
    payload?: Record<string, unknown>;
  };
  clientState?: Record<string, unknown>;
};

export type CopilotChatResponse = {
  sessionId: string;
  turnId: string;
  assistantMessage: CopilotMessage;
  timeline: ProductTimelineItem[];
  workspace: CopilotWorkspace;
  nextActions: ProductAction[];
  suggestedPrompts?: SuggestedPrompt[];
  raw: {
    artifactIds: string[];
    evidenceChainIds: string[];
    critiqueItemIds: string[];
    decisionIds: string[];
    metadata?: Record<string, unknown>;
    exportId?: string;
    jobId?: string;
    resumeId?: string;
    format?: string;
    actionResults?: CopilotActionResult[];
    primaryActionResult?: CopilotActionResult;
  };
};

export type CopilotSessionSummary = {
  id: string;
  title?: string | null;
  targetRole?: string | null;
  status?: string;
  updatedAt: string;
};

export type CopilotSessionDetail = {
  session: CopilotSessionSummary;
  messages: CopilotMessage[];
  workspace?: CopilotWorkspace | null;
  turns: unknown[];
};

export type CopilotSidebarResponse = {
  recentSessions: CopilotSessionSummary[];
  recentResumes: ProductResumeSummary[];
  recentJDs: ProductJDSummary[];
  recentExperiences: ProductExperienceSummary[];
  recentActivities: Array<{ id: string; type: string; title: string; description?: string | null; createdAt: string }>;
};

export type AgentModesResponse = {
  provider: string;
  database: string;
  runtimeMode: string;
  nodeEnv?: string;
  frontDeskMode: string;
  artifactGeneratorMode: string;
  experienceExtractorMode?: string;
  criticAgentMode?: string;
  revisionAgentMode?: string;
  allowMockFallback?: boolean;
  model?: string;
  warnings?: string[];
};

// ---------------------------------------------------------------------------
// Phase 9: Phase 1–8b additive contract surface (frontend type mirror).
//
// All types below are OPTIONAL on the wire and additive — a frontend that
// ignores them keeps working byte-for-byte with the legacy contract. None of
// them rename or repurpose existing fields. See:
//   docs/CONTRACT.md §16
//   docs/coolto_frontend_backend_contract_v2.md §18
//   docs/frontend_backend_contract_llm_first.md §十五
// for the full contract.
// ---------------------------------------------------------------------------

// Phase 1: ToolResult structured fields ---------------------------------------

export type ToolResultEntity = {
  type: string;
  id?: string;
  title?: string;
  data?: unknown;
};

export type ToolResultEvidence = {
  sourceId?: string;
  claim?: string;
  support?: string;
  confidence?: number;
};

export type ToolResultNextActionHint = {
  type: string;
  label: string;
  payload?: Record<string, unknown>;
};

export type StructuredToolResult = {
  status: "success" | "needs_input" | "failed";
  message?: string;
  data?: unknown;
  workspacePatch?: Record<string, unknown>;
  actionResult?: Record<string, unknown>;
  pendingActionId?: string;
  visibility?: string;
  resultKind?: string;
  summaryFacts?: string[];
  entities?: ToolResultEntity[];
  evidence?: ToolResultEvidence[];
  warnings?: string[];
  nextActionHints?: ToolResultNextActionHint[];
};

// Phase 3: ResumeDocument -----------------------------------------------------

export type ResumeDocumentBullet = {
  id: string;
  text: string;
  evidenceIds?: string[];
};

export type ResumeDocumentItem = {
  id: string;
  title: string;
  subtitle?: string;
  period?: string;
  location?: string;
  bullets: ResumeDocumentBullet[];
  sourceExperienceId?: string;
  evidenceStrength?: "low" | "medium" | "high";
  relevanceScore?: number;
};

export type ResumeDocumentSection = {
  id: string;
  type: string;
  title: string;
  order: number;
  items: ResumeDocumentItem[];
};

export type ResumeDocument = {
  schemaVersion: 1;
  sections: ResumeDocumentSection[];
};

// Phase 5: ResumeFitReport ----------------------------------------------------

export type ResumeFitReport = {
  targetPages: number;
  estimatedPages: number;
  overflowPx: number;
  underflowPx?: number;
  contentHeightPx: number;
  pageUsableHeightPx: number;
  templateId: string;
  density: string;
  measurer: "playwright" | "heuristic";
  measuredAt: string;
};

// Phase 6: ResumeCompressionReport --------------------------------------------

export type ResumeCompressionAction =
  | { type: "drop_bullet"; itemId: string; bulletId: string }
  | { type: "shorten_bullet"; itemId: string; bulletId?: string; before: string; after: string }
  | { type: "merge_bullets"; itemId: string; bulletIds: string[]; mergedText: string }
  | { type: "hide_item"; itemId: string; sectionType: string; reason: "low_relevance" }
  | { type: "drop_density"; from: string; to: string };

export type ResumeCompressionReport = {
  applied: boolean;
  initialEstimatedPages: number;
  finalEstimatedPages: number;
  initialOverflowPx: number;
  finalOverflowPx: number;
  iterations: number;
  actions: ResumeCompressionAction[];
  densityBefore: string;
  densityAfter: string;
  stillOverflowing: boolean;
  reason: "overflow_resolved" | "no_more_strategies" | "iteration_limit";
};

// Phase 7: ResumeFitEditorReport ----------------------------------------------

export type ResumeFitEditorReason =
  | "no_model_client"
  | "no_actions"
  | "schema_invalid"
  | "model_error"
  | "regression"
  | "edits_applied"
  | "all_rejected";

export type ResumeFitEditorAppliedAction = {
  type: "shorten_bullet" | "rephrase_bullet" | "drop_bullet" | "expand_bullet";
  itemId: string;
  bulletId: string;
  before?: string;
  after?: string;
};

export type ResumeFitEditorRejectedAction = {
  type: string;
  itemId?: string;
  bulletId?: string;
  reason: string;
};

export type ResumeFitEditorReport = {
  applied: boolean;
  fallback: boolean;
  trigger: "shrink_to_fit" | "fill_underflow" | null;
  reason: ResumeFitEditorReason;
  initialEstimatedPages: number;
  finalEstimatedPages: number;
  initialOverflowPx: number;
  finalOverflowPx: number;
  initialUnderflowPx: number;
  finalUnderflowPx: number;
  actions: ResumeFitEditorAppliedAction[];
  rejectedActions?: ResumeFitEditorRejectedAction[];
  notes?: string;
  llmReason?: string;
  measuredAt: string;
};

// Phase 8: ResumeQualityReport ------------------------------------------------

export type ResumeQualityDimension =
  | "authenticity"
  | "jd_match"
  | "evidence"
  | "metric"
  | "expression"
  | "layout";

export type ResumeQualityRiskLevel = "low" | "medium" | "high" | "critical";

export type ResumeQualityRisk = {
  id: string;
  level: ResumeQualityRiskLevel;
  dimension: ResumeQualityDimension;
  message: string;
  itemId?: string;
  bulletId?: string;
};

export type ResumeQualitySuggestion = {
  id: string;
  dimension: ResumeQualityDimension;
  message: string;
  itemId?: string;
  bulletId?: string;
};

// Phase 8b: ResumeQualityCriticReview -----------------------------------------

export type ResumeQualityCriticReason =
  | "no_model_client"
  | "disabled_by_env"
  | "no_rule_report"
  | "schema_invalid"
  | "model_error"
  | "ok";

export type ResumeQualityCriticRisk = {
  id: string;
  level: ResumeQualityRiskLevel;
  message: string;
  itemId?: string;
  bulletId?: string;
  evidenceMissing?: boolean;
};

export type ResumeQualityCriticRewriteSuggestion = {
  id: string;
  itemId?: string;
  bulletId?: string;
  before?: string;
  suggestion: string;
  reason: string;
};

export type ResumeQualityCriticMissingEvidence = {
  id: string;
  bulletId?: string;
  claim: string;
  reason: string;
};

export type ResumeQualityCriticRejectedReference = {
  kind: "risk" | "suggestion" | "missingEvidence";
  itemId?: string;
  bulletId?: string;
  why: "unknown_item" | "unknown_bullet";
};

export type ResumeQualityCriticReview = {
  applied: boolean;
  fallback: boolean;
  reason: ResumeQualityCriticReason;
  semanticJdMatchScore?: number;
  expressionQualityScore?: number;
  authenticityRisks: ResumeQualityCriticRisk[];
  rewriteSuggestions: ResumeQualityCriticRewriteSuggestion[];
  missingEvidence: ResumeQualityCriticMissingEvidence[];
  overallComment?: string;
  rejectedReferences?: ResumeQualityCriticRejectedReference[];
  llmReason?: string;
  generatedAt: string;
};

export type ResumeQualityReport = {
  overallScore: number;
  authenticityScore: number;
  jdMatchScore: number;
  evidenceScore: number;
  metricScore: number;
  expressionScore: number;
  layoutScore: number;
  risks: ResumeQualityRisk[];
  suggestions: ResumeQualitySuggestion[];
  unsupportedClaims: string[];
  hasCriticalRisks: boolean;
  generatedAt: string;
  criticReview?: ResumeQualityCriticReview;
};

// ResumeExport additive view (Phase 5 / 6 / 7 / 8 / 8b) -----------------------

export type ResumeExportAdditive = {
  /** Phase 5. Present after status="completed". May be undefined for legacy exports. */
  fitReport?: ResumeFitReport;
  /** Phase 6. Present only when rule-based one-page compression actually ran. */
  compressionReport?: ResumeCompressionReport;
  /** Phase 7. Present only when ENABLE_LLM_FIT_EDITOR + modelClient + (overflow/underflow). */
  editReport?: ResumeFitEditorReport;
  /** Phase 8. Present when status="completed" and a fitReport was produced. */
  qualityReport?: ResumeQualityReport;
};

// ProductGenerationVariant additive view (Phase 3) ----------------------------

export type ProductGenerationVariantAdditive = {
  /** Phase 3. Optional structured doc next to legacy markdown `content`. */
  resumeDocument?: ResumeDocument;
};

// CopilotChatResponse additive view (Phase 1) ---------------------------------

export type CopilotChatResponseRawAdditive = {
  /**
   * Phase 1. Backend-side full ToolResult array carried alongside the existing
   * `actionResults`. Frontend may ignore — `actionResults` and the legacy
   * envelope continue to be the canonical render path.
   */
  toolResults?: StructuredToolResult[];
};
