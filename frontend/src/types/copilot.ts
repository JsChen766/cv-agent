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
    | "decision_recorded"
    | "evidence_opened"
    | "warning";
  title: string;
  description?: string;
  status: "pending" | "running" | "completed" | "failed";
  createdAt: string;
  relatedVariantId?: string;
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
