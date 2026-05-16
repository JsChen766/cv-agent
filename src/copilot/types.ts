export type CopilotSession = {
  id: string;
  userId?: string | null;
  title?: string | null;
  targetRole?: string | null;
  resumeText?: string | null;
  jdText?: string | null;
  currentWorkspaceId?: string | null;
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
  artifactId?: string | null;
  title: string;
  subtitle?: string | null;
  before?: string | null;
  after: string;
  targetRole?: string | null;
  section?: string | null;
  score?: {
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
  highlights: Array<{
    label: string;
    text: string;
  }>;
  critiqueSummary?: {
    strengths: string[];
    risks: string[];
    suggestions: string[];
  };
  evidenceSummary?: {
    coverageLabel: string;
    items: Array<{
      id: string;
      title: string;
      quote?: string;
      explanation: string;
      confidence?: number;
    }>;
  };
  decisionState: "undecided" | "preferred" | "accepted" | "rejected";
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
  requiresInput?: boolean;
  inputPlaceholder?: string;
};

export type ProductTimelineItem = {
  id: string;
  type:
    | "user_submitted"
    | "resume_analyzed"
    | "jd_analyzed"
    | "experience_matched"
    | "variant_generated"
    | "critique_completed"
    | "evidence_attached"
    | "user_decision"
    | "revision_completed"
    | "error";
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
  | { type: "timeline"; item: ProductTimelineItem }
  | { type: "assistant_message_delta"; content: string }
  | { type: "workspace_patch"; patch: Partial<CopilotWorkspace> }
  | { type: "variant_created"; variant: ProductVariant }
  | { type: "next_actions"; actions: ProductAction[] }
  | { type: "done"; sessionId: string; turnId: string }
  | { type: "error"; message: string };

// Safety: the raw field must only contain debug-safe IDs and metadata,
// never internal chain-of-thought, reasoning_content, prompts, or tool args.
export type CopilotRawSection = {
  artifactIds: string[];
  evidenceChainIds: string[];
  critiqueItemIds: string[];
  decisionIds: string[];
};
