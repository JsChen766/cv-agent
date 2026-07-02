import type {
  ResumeOptimizationFailureReason,
  ResumeOptimizationNextAction,
  ResumeOptimizationRecoveryPlan,
  ResumeOptimizationStage,
} from "./types.js";

export class ResumeWorkflowRecoveryService {
  public classify(input: {
    error?: unknown;
    message?: string;
    stage?: ResumeOptimizationStage;
    partialArtifactTypes?: string[];
  }): ResumeOptimizationRecoveryPlan {
    const rawMessage = input.message ?? errorMessage(input.error);
    const lower = rawMessage.toLowerCase();
    const partialArtifactTypes = input.partialArtifactTypes ?? [];

    if (includesAny(lower, ["jd text", "jdid", "job description", "jd is required"])) {
      return plan({
        reason: "missing_jd",
        stage: "intake",
        status: "needs_input",
        userMessage: "A JD is required before resume optimization can continue.",
        nextAction: { type: "provide_jd", label: "Provide the job description" },
        retryable: false,
        partialArtifactTypes,
        partialDraftPolicy: "not_available",
      });
    }

    if (includesAny(lower, ["company or role", "target company", "target role missing", "missing role"])) {
      return plan({
        reason: "missing_target_context",
        stage: "jd_analysis",
        status: "needs_input",
        userMessage: "The JD is missing target company or role context. Confirm those details before final tailoring.",
        nextAction: { type: "complete_jd_context", label: "Confirm target company and role" },
        retryable: false,
        partialArtifactTypes,
        partialDraftPolicy: partialArtifactTypes.length > 0 ? "keep_visible" : "not_available",
      });
    }

    if (lower.includes("evidence") && includesAny(lower, ["shortage", "insufficient", "not enough", "missing"])) {
      return plan({
        reason: "evidence_shortage",
        stage: "evidence_pack",
        status: "needs_input",
        userMessage: "Evidence is insufficient for safe optimization. Existing drafts can stay visible, but risky claims need more source material.",
        nextAction: {
          type: "add_experience_evidence",
          label: "Add stronger experience evidence",
          payload: { conservativeChanges: true },
        },
        retryable: false,
        partialArtifactTypes,
        partialDraftPolicy: partialArtifactTypes.length > 0 ? "keep_visible" : "not_available",
        riskNote: "Only conservative, evidence-backed changes should be accepted until missing evidence is resolved.",
      });
    }

    if (includesAny(lower, ["weak match", "low jd", "low match", "poor match"])) {
      return plan({
        reason: "weak_match",
        stage: "jd_analysis",
        status: "needs_input",
        userMessage: "The resume evidence is a weak match for this JD. Add relevant experience or confirm an alternate positioning angle.",
        nextAction: {
          type: "add_experience_evidence",
          label: "Add evidence or confirm a conservative positioning angle",
          payload: { conservativeChanges: true },
        },
        retryable: false,
        partialArtifactTypes,
        partialDraftPolicy: partialArtifactTypes.length > 0 ? "keep_visible" : "not_available",
        riskNote: "Weak-match content should be marked incomplete rather than presented as application-ready.",
      });
    }

    if (includesAny(lower, ["timeout", "timed out", "etimedout"])) {
      return retryPlan({
        reason: "llm_timeout",
        stage: input.stage ?? "draft_generation",
        userMessage: "The model timed out. Completed workflow stages were preserved, and only the failed stage should be retried.",
        nextAction: { type: "retry_stage", label: "Retry the failed stage" },
        partialArtifactTypes,
      });
    }

    if (includesAny(lower, ["json_parse", "json parse", "invalid json", "strict json", "could not be parsed"])) {
      return retryPlan({
        reason: "llm_invalid_json",
        stage: input.stage ?? "draft_generation",
        userMessage: "The model returned invalid structured output. Completed stages were preserved; retry draft generation with the same evidence.",
        nextAction: { type: "retry_stage", label: "Retry draft generation" },
        partialArtifactTypes,
      });
    }

    if (includesAny(lower, ["schema_validation", "schema validation", "schema issues"])) {
      return retryPlan({
        reason: "llm_schema_validation",
        stage: input.stage ?? "draft_generation",
        userMessage: "The model output did not match the required resume schema. Completed stages were preserved; retry draft generation.",
        nextAction: { type: "retry_stage", label: "Retry draft generation" },
        partialArtifactTypes,
      });
    }

    if (includesAny(lower, ["llm_provider_not_configured", "model provider is not configured", "no ai model provider", "model_not_available"])) {
      return plan({
        reason: "model_not_available",
        stage: input.stage ?? "draft_generation",
        status: "needs_input",
        userMessage: "The model provider is not configured, so resume generation cannot continue yet.",
        nextAction: { type: "configure_model_provider", label: "Configure the model provider" },
        retryable: false,
        partialArtifactTypes,
        partialDraftPolicy: "not_available",
      });
    }

    if (lower.includes("underfill")) {
      return retryPlan({
        reason: "layout_underfill",
        stage: "layout_check",
        userMessage: "The layout check found the resume underfilled the target A4 page. Keep the draft visible and add evidence-backed detail.",
        nextAction: {
          type: "retry_layout_check",
          label: "Add grounded detail and rerun layout check",
          payload: { remediation: "expand_grounded_content" },
        },
        partialArtifactTypes,
        riskNote: "Do not pad content with unsupported claims or artificial spacing.",
      });
    }

    if (includesAny(lower, ["layout", "overflow"])) {
      return retryPlan({
        reason: lower.includes("overflow") ? "layout_overflow" : "layout_failure",
        stage: "layout_check",
        userMessage: "The layout check failed. Keep the draft visible and retry only layout remediation.",
        nextAction: {
          type: "retry_layout_check",
          label: "Compact content and rerun layout check",
          payload: { remediation: "compact_layout" },
        },
        partialArtifactTypes,
        riskNote: "Layout remediation should preserve evidence-backed content and avoid an ungrounded full rewrite.",
      });
    }

    if (includesAny(lower, ["critic", "review failed", "quality critic"])) {
      return retryPlan({
        reason: "critic_failure",
        stage: "critic_review",
        userMessage: "The critic review failed. Completed draft and layout work were preserved; retry only the critic stage.",
        nextAction: { type: "retry_critic_review", label: "Retry critic review" },
        partialArtifactTypes,
      });
    }

    if (includesAny(lower, ["export", "pdf", "playwright", "chromium", "renderer"])) {
      return retryPlan({
        reason: "export_failure",
        stage: "exported",
        userMessage: "Export failed. The accepted resume remains available; retry export after checking the renderer or format.",
        nextAction: { type: "retry_export", label: "Retry export" },
        partialArtifactTypes,
      });
    }

    return retryPlan({
      reason: "workflow_failed",
      stage: input.stage ?? "failed",
      userMessage: "Resume optimization failed. Completed workflow stages were preserved; retry the failed stage.",
      nextAction: { type: "retry_stage", label: "Retry the failed stage" },
      partialArtifactTypes,
    });
  }

  public sanitizeFailureMessage(input: { error?: unknown; message?: string; stage?: ResumeOptimizationStage }): string {
    return this.classify(input).userMessage;
  }
}

function retryPlan(input: {
  reason: ResumeOptimizationFailureReason;
  stage: ResumeOptimizationStage;
  userMessage: string;
  nextAction: ResumeOptimizationNextAction;
  partialArtifactTypes: string[];
  riskNote?: string;
}): ResumeOptimizationRecoveryPlan {
  return plan({
    ...input,
    status: "failed",
    retryable: true,
    partialDraftPolicy: input.partialArtifactTypes.length > 0 ? "keep_visible" : "not_available",
  });
}

function plan(input: Omit<ResumeOptimizationRecoveryPlan, "schemaVersion" | "preserveCompletedStages">): ResumeOptimizationRecoveryPlan {
  return {
    schemaVersion: 1,
    preserveCompletedStages: true,
    ...input,
    nextAction: {
      ...input.nextAction,
      payload: {
        failedStage: input.stage,
        retryOnlyFailedStage: input.retryable,
        ...(input.nextAction.payload ?? {}),
      },
    },
  };
}

function includesAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Resume optimization failed.");
}
