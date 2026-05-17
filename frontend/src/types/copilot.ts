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

export type ProductAction = {
  id: string;
  type:
    | "accept"
    | "reject"
    | "prefer"
    | "confirm_metric"
    | "revise_more_conservative"
    | "revise_more_quantified"
    | "show_evidence"
    | "explain_choice";
  label: string;
  description?: string;
  variantId?: string;
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
  variants: ProductVariant[];
  status: "empty" | "ready" | "generating" | "awaiting_user_decision" | "accepted" | "revision_needed";
  summary?: string;
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
    type: ProductAction["type"];
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
  raw: {
    artifactIds: string[];
    evidenceChainIds: string[];
    critiqueItemIds: string[];
    decisionIds: string[];
  };
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
