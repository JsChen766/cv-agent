export type CopilotSession = {
  id: string;
  userId?: string | null;
  title?: string | null;
  targetRole?: string | null;
  resumeText?: string | null;
  jdText?: string | null;
  currentWorkspaceId?: string | null;
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
  metadata?: Record<string, unknown>;
};

export type CopilotWorkspace = {
  id: string;
  sessionId: string;
  activeVariantId?: string | null;
  variants: ProductVariant[];
  selectedEvidenceChainId?: string | null;
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
  // Backward-compat aliases
  /** @deprecated use inputSchema */
  requiresInput?: boolean;
  /** @deprecated use inputSchema.fields[0].placeholder */
  inputPlaceholder?: string;
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

export type CopilotChatRequest = {
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

export type CopilotActionRequest = {
  sessionId: string;
  turnId?: string;
  action: {
    type: ProductAction["type"];
    variantId?: string;
    payload?: Record<string, unknown>;
  };
  clientState?: Record<string, unknown>;
};

export type CopilotStreamEvent =
  | { type: "copilot.turn.started"; sessionId: string; turnId: string }
  | { type: "copilot.message.created"; message: CopilotMessage }
  | { type: "copilot.timeline.updated"; item: ProductTimelineItem }
  | { type: "copilot.workspace.updated"; sessionId: string; status: CopilotWorkspace["status"]; variantCount: number }
  | { type: "copilot.action.required"; actions: ProductAction[] }
  | { type: "copilot.completed"; sessionId: string; turnId: string; workspaceStatus: CopilotWorkspace["status"] }
  | { type: "copilot.failed"; sessionId: string; turnId: string; message: string };

export type CopilotRawSection = {
  artifactIds: string[];
  evidenceChainIds: string[];
  critiqueItemIds: string[];
  decisionIds: string[];
};
