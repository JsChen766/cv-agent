import { randomUUID } from "node:crypto";
import type { EvidencePack } from "../../rag/evidence/index.js";
import type { ProductGeneratedVariant, ProductGeneration, ProductJDRecord } from "../types.js";
import {
  RESUME_OPTIMIZATION_STAGES,
  type ResumeEditorialCriticReview,
  type ResumeChangeSet,
  type ResumeOptimizationNextAction,
  type ResumeOptimizationRun,
  type ResumeOptimizationRunInput,
  type ResumeOptimizationStage,
  type ResumeOptimizationStageState,
  type ResumeOptimizationStageStatus,
  type ResumeOptimizationRecoveryPlan,
} from "./types.js";
import { ResumeWorkflowRecoveryService } from "./ResumeWorkflowRecoveryService.js";

const STAGE_LABELS: Record<ResumeOptimizationStage, string> = {
  intake: "Intake",
  jd_analysis: "JD analysis",
  evidence_pack: "Evidence pack",
  rewrite_plan: "Rewrite plan",
  draft_generation: "Draft generation",
  layout_check: "Layout check",
  critic_review: "Critic review",
  change_set_ready: "Change set ready",
  accepted: "Accepted",
  exported: "Exported",
  failed: "Failed",
  needs_input: "Needs input",
};

export class ResumeOptimizationWorkflowService {
  public constructor(private readonly recoveryService: ResumeWorkflowRecoveryService = new ResumeWorkflowRecoveryService()) {}

  public startRun(input: ResumeOptimizationRunInput): ResumeOptimizationRun {
    const now = new Date().toISOString();
    const run = this.createBaseRun(input, now);
    if (!input.jdId && !input.jdText?.trim()) {
      return this.markNeedsInput(run, "intake", {
        message: "A JD is required before resume optimization can start.",
        nextAction: {
          type: "provide_jd",
          label: "Provide the job description",
        },
      });
    }

    return this.markRunning(
      this.markCompleted(run, "intake", {
        message: "Resume optimization request accepted.",
      }),
      "jd_analysis",
      {
        message: "Waiting to analyze the JD and target role.",
      },
    );
  }

  public startQueuedGenerationRun(input: ResumeOptimizationRunInput & { jobId: string }): ResumeOptimizationRun {
    const run = this.startRun(input);
    if (run.status === "needs_input") return run;
    return this.markQueued(run, input.jobId);
  }

  public markQueued(run: ResumeOptimizationRun, jobId: string): ResumeOptimizationRun {
    return {
      ...this.markRunning(run, "jd_analysis", {
        message: "Generation job is queued; JD analysis will run in the background job.",
        artifactIds: { jobId },
      }),
      jobId,
    };
  }

  public completeDraftGeneration(input: {
    run: ResumeOptimizationRun;
    jd: ProductJDRecord;
    generation: ProductGeneration;
    variants: ProductGeneratedVariant[];
    sourceExperienceIds: string[];
    evidencePack?: EvidencePack;
    targetRole?: string;
    resumeChangeSet?: ResumeChangeSet;
    editorialCriticReview?: ResumeEditorialCriticReview;
  }): ResumeOptimizationRun {
    const jdNextAction = this.buildJdNextAction(input.jd, input.targetRole);
    const evidenceNextAction = input.sourceExperienceIds.length === 0
      ? {
          type: "add_experience_evidence",
          label: "Add or import experience evidence before accepting the final resume",
          payload: {
            conservativeChanges: true,
            missingEvidenceNote: "No active source experiences were available; keep generated changes conservative until evidence is added.",
          },
        }
      : undefined;
    const evidenceCount = countEvidenceItems(input.evidencePack);
    const draftNextAction = input.variants.length > 0
      ? {
          type: "review_variants",
          label: "Review generated resume variants",
          payload: { generationId: input.generation.id },
        }
      : undefined;

    let run: ResumeOptimizationRun = {
      ...input.run,
      generationId: input.generation.id,
      jdId: input.jd.id,
    };
    run = this.markCompleted(run, "jd_analysis", {
      message: jdNextAction
        ? "JD analyzed; company or role information is incomplete."
        : "JD analyzed.",
      artifactIds: { jdId: input.jd.id },
      nextAction: jdNextAction,
    });
    run = this.markCompleted(run, "evidence_pack", {
      message: evidenceCount > 0
        ? `Evidence pack prepared with ${evidenceCount} item(s).`
        : "Evidence pack is empty; generation will stay conservative.",
      artifactIds: { experienceIds: input.sourceExperienceIds },
      nextAction: evidenceNextAction,
    });
    run = this.markCompleted(run, "rewrite_plan", {
      message: "Rewrite plan derived from the JD and available evidence.",
    });
    run = this.markCompleted(run, "draft_generation", {
      message: `Generated ${input.variants.length} resume variant(s).`,
      artifactIds: {
        generationId: input.generation.id,
        variantIds: input.variants.map((variant) => variant.id),
      },
      nextAction: draftNextAction,
    });
    if (input.editorialCriticReview) {
      const criticNextAction = this.buildCriticNextAction(input.editorialCriticReview);
      run = this.markCompleted(run, "critic_review", {
        message: input.editorialCriticReview.summary.label,
        artifactIds: {
          generationId: input.generation.id,
          criticReviewId: input.editorialCriticReview.reviewId,
          criticPatchSuggestionIds: input.editorialCriticReview.patchSuggestions.map((suggestion) => suggestion.suggestionId),
        },
        nextAction: criticNextAction,
      });
    }
    const changeSetNextAction = input.resumeChangeSet
      ? {
          type: "review_resume_change_set",
          label: input.resumeChangeSet.summary.label,
          payload: {
            generationId: input.generation.id,
            changeSetId: input.resumeChangeSet.changeSetId,
            variantId: input.resumeChangeSet.variantId,
          },
        }
      : draftNextAction;
    run = this.markCompleted(run, "change_set_ready", {
      message: input.resumeChangeSet
        ? input.resumeChangeSet.summary.label
        : "Generated variants are ready for user review.",
      artifactIds: {
        generationId: input.generation.id,
        changeSetId: input.resumeChangeSet?.changeSetId,
      },
      nextAction: changeSetNextAction,
    });
    return {
      ...run,
      status: "running",
      currentStage: "change_set_ready",
      updatedAt: new Date().toISOString(),
    };
  }

  public markAccepted(input: {
    run: ResumeOptimizationRun;
    resumeId: string;
    generationId?: string;
    variantId?: string;
  }): ResumeOptimizationRun {
    return this.markCompleted(input.run, "accepted", {
      message: "The selected variant was accepted into a resume.",
      artifactIds: {
        resumeId: input.resumeId,
        generationId: input.generationId,
        variantId: input.variantId,
      },
      nextAction: {
        type: "export_resume",
        label: "Export the accepted resume",
        payload: { resumeId: input.resumeId, format: "pdf" },
      },
    });
  }

  public markExported(input: {
    run: ResumeOptimizationRun;
    resumeId: string;
    exportId: string;
    fileId?: string;
  }): ResumeOptimizationRun {
    const run = this.markCompleted(input.run, "exported", {
      message: "The resume export was created.",
      artifactIds: {
        resumeId: input.resumeId,
        exportId: input.exportId,
        fileId: input.fileId,
      },
    });
    return {
      ...run,
      status: "completed",
      currentStage: "exported",
      updatedAt: new Date().toISOString(),
    };
  }

  public markFailure(input: {
    run: ResumeOptimizationRun;
    error: unknown;
    stage?: ResumeOptimizationStage;
  }): ResumeOptimizationRun {
    const recoveryPlan = this.recoveryService.classify({
      error: input.error,
      stage: input.stage,
      partialArtifactTypes: partialArtifactTypes(input.run),
    });
    if (recoveryPlan.status === "needs_input") {
      return this.markNeedsInput(input.run, recoveryPlan.stage, {
        message: recoveryPlan.userMessage,
        failureReason: recoveryPlan.reason,
        nextAction: recoveryPlan.nextAction,
        recoveryPlan,
      });
    }
    const failedRun = this.transition(input.run, recoveryPlan.stage, "failed", {
      message: recoveryPlan.userMessage,
      failureReason: recoveryPlan.reason,
      nextAction: recoveryPlan.nextAction,
      recoveryPlan,
    });
    return {
      ...failedRun,
      status: "failed",
      currentStage: "failed",
      failureReason: recoveryPlan.reason,
      nextAction: recoveryPlan.nextAction,
      recoveryPlan,
      updatedAt: new Date().toISOString(),
    };
  }

  public fromSnapshot(value: unknown): ResumeOptimizationRun | undefined {
    if (!isRecord(value)) return undefined;
    if (value.schemaVersion !== 1 || typeof value.runId !== "string") return undefined;
    if (!Array.isArray(value.stages) || !Array.isArray(value.events)) return undefined;
    return value as ResumeOptimizationRun;
  }

  private createBaseRun(input: ResumeOptimizationRunInput, now: string): ResumeOptimizationRun {
    const stages: ResumeOptimizationStageState[] = RESUME_OPTIMIZATION_STAGES.map((stage) => ({
      stage,
      status: "pending",
      label: STAGE_LABELS[stage],
    }));
    return {
      schemaVersion: 1,
      runId: `rowf-${randomUUID()}`,
      userId: input.userId,
      sessionId: input.sessionId,
      jdId: input.jdId,
      jobId: input.jobId,
      status: "pending",
      currentStage: "intake",
      stages,
      events: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private markRunning(run: ResumeOptimizationRun, stage: ResumeOptimizationStage, input: TransitionInput = {}): ResumeOptimizationRun {
    return this.transition(run, stage, "running", input);
  }

  private markCompleted(run: ResumeOptimizationRun, stage: ResumeOptimizationStage, input: TransitionInput = {}): ResumeOptimizationRun {
    return this.transition(run, stage, "completed", input);
  }

  private markNeedsInput(run: ResumeOptimizationRun, stage: ResumeOptimizationStage, input: TransitionInput): ResumeOptimizationRun {
    const next = this.transition(run, stage, "needs_input", input);
    return {
      ...next,
      status: "needs_input",
      currentStage: "needs_input",
      failureReason: input.failureReason ?? next.failureReason,
      nextAction: input.nextAction,
      recoveryPlan: input.recoveryPlan,
      updatedAt: new Date().toISOString(),
    };
  }

  private transition(
    run: ResumeOptimizationRun,
    stage: ResumeOptimizationStage,
    status: ResumeOptimizationStageStatus,
    input: TransitionInput = {},
  ): ResumeOptimizationRun {
    const now = new Date().toISOString();
    const message = input.message ?? `${STAGE_LABELS[stage]} ${status}.`;
    const stages = run.stages.map((item) => {
      if (item.stage !== stage) return item;
      return {
        ...item,
        status,
        message,
        startedAt: item.startedAt ?? now,
        completedAt: status === "completed" || status === "failed" || status === "needs_input" ? now : item.completedAt,
        artifactIds: input.artifactIds ?? item.artifactIds,
        failureReason: input.failureReason,
        nextAction: input.nextAction,
        recoveryPlan: input.recoveryPlan,
      };
    });
    return {
      ...run,
      status: status === "failed" ? "failed" : status === "needs_input" ? "needs_input" : "running",
      currentStage: stage,
      stages,
      events: [
        ...run.events,
        {
          id: `rowfe-${randomUUID()}`,
          runId: run.runId,
          stage,
          status,
          message,
          createdAt: now,
          artifactIds: input.artifactIds,
          nextAction: input.nextAction,
          recoveryPlan: input.recoveryPlan,
        },
      ],
      updatedAt: now,
      failureReason: input.failureReason ?? run.failureReason,
      nextAction: input.nextAction ?? run.nextAction,
      recoveryPlan: input.recoveryPlan ?? run.recoveryPlan,
    };
  }

  private buildJdNextAction(jd: ProductJDRecord, targetRole?: string): ResumeOptimizationNextAction | undefined {
    if (jd.company && (targetRole || jd.targetRole)) return undefined;
    return {
      type: "complete_jd_context",
      label: "Confirm the target company and role for sharper tailoring",
      payload: {
        jdId: jd.id,
        missingCompany: !jd.company,
        missingTargetRole: !(targetRole || jd.targetRole),
      },
    };
  }

  private buildCriticNextAction(review: ResumeEditorialCriticReview): ResumeOptimizationNextAction | undefined {
    const firstNeedsInput = review.items.find((item) => item.nextAction && !item.autoFixAllowed);
    if (firstNeedsInput?.nextAction) return firstNeedsInput.nextAction;
    if (review.patchSuggestions.length === 0) return undefined;
    return {
      type: "review_critic_patch_suggestions",
      label: review.summary.label,
      payload: {
        criticReviewId: review.reviewId,
        changeSetId: review.changeSetId,
        patchSuggestionIds: review.patchSuggestions.map((suggestion) => suggestion.suggestionId),
      },
    };
  }
}

type TransitionInput = {
  message?: string;
  artifactIds?: Record<string, string | string[] | undefined>;
  failureReason?: string;
  nextAction?: ResumeOptimizationNextAction;
  recoveryPlan?: ResumeOptimizationRecoveryPlan;
};

function countEvidenceItems(evidencePack: EvidencePack | undefined): number {
  if (!evidencePack) return 0;
  const maybeItems = evidencePack as unknown as Record<string, unknown>;
  if (Array.isArray(maybeItems.items)) return maybeItems.items.length;
  if (Array.isArray(maybeItems.evidenceItems)) return maybeItems.evidenceItems.length;
  if (Array.isArray(maybeItems.claims)) return maybeItems.claims.length;
  return 0;
}

function partialArtifactTypes(run: ResumeOptimizationRun): string[] {
  const types: string[] = [];
  if (run.jdId) types.push("jd");
  if (run.generationId) types.push("generation");
  if (run.stages.some((stage) => stage.stage === "draft_generation" && stage.status === "completed")) {
    types.push("resumeDocumentDraft");
  }
  if (run.stages.some((stage) => stage.stage === "change_set_ready" && stage.status === "completed")) {
    types.push("resumeChangeSet");
  }
  return types;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
