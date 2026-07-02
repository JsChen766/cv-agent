import { randomUUID } from "node:crypto";
import type { EvidencePack } from "../../rag/evidence/index.js";
import type { ProductGeneratedVariant, ProductGeneration, ProductJDRecord } from "../types.js";
import {
  RESUME_OPTIMIZATION_STAGES,
  type ResumeChangeSet,
  type ResumeOptimizationNextAction,
  type ResumeOptimizationRun,
  type ResumeOptimizationRunInput,
  type ResumeOptimizationStage,
  type ResumeOptimizationStageState,
  type ResumeOptimizationStageStatus,
} from "./types.js";

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
  }): ResumeOptimizationRun {
    const jdNextAction = this.buildJdNextAction(input.jd, input.targetRole);
    const evidenceNextAction = input.sourceExperienceIds.length === 0
      ? {
          type: "add_experience_evidence",
          label: "Add or import experience evidence before accepting the final resume",
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
    const message = errorMessage(input.error);
    const classified = classifyFailure(message, input.stage);
    if (classified.status === "needs_input") {
      return this.markNeedsInput(input.run, classified.stage, {
        message: classified.message,
        nextAction: classified.nextAction,
      });
    }
    const failedRun = this.transition(input.run, classified.stage, "failed", {
      message: classified.message,
      failureReason: classified.reason,
      nextAction: classified.nextAction,
    });
    return {
      ...failedRun,
      status: "failed",
      currentStage: "failed",
      failureReason: classified.reason,
      nextAction: classified.nextAction,
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
      nextAction: input.nextAction,
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
        },
      ],
      updatedAt: now,
      failureReason: input.failureReason ?? run.failureReason,
      nextAction: input.nextAction ?? run.nextAction,
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
}

type TransitionInput = {
  message?: string;
  artifactIds?: Record<string, string | string[] | undefined>;
  failureReason?: string;
  nextAction?: ResumeOptimizationNextAction;
};

function countEvidenceItems(evidencePack: EvidencePack | undefined): number {
  if (!evidencePack) return 0;
  const maybeItems = evidencePack as unknown as Record<string, unknown>;
  if (Array.isArray(maybeItems.items)) return maybeItems.items.length;
  if (Array.isArray(maybeItems.evidenceItems)) return maybeItems.evidenceItems.length;
  if (Array.isArray(maybeItems.claims)) return maybeItems.claims.length;
  return 0;
}

function classifyFailure(message: string, stage: ResumeOptimizationStage | undefined): {
  stage: ResumeOptimizationStage;
  status: "failed" | "needs_input";
  message: string;
  reason: string;
  nextAction: ResumeOptimizationNextAction;
} {
  const lower = message.toLowerCase();
  if (lower.includes("jd text") || lower.includes("jdid") || lower.includes("job description")) {
    return {
      stage: "needs_input",
      status: "needs_input",
      message: "A JD is required before resume optimization can continue.",
      reason: "missing_jd",
      nextAction: { type: "provide_jd", label: "Provide the job description" },
    };
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("etimedout")) {
    return {
      stage: stage ?? "draft_generation",
      status: "failed",
      message: "The LLM call timed out; completed workflow state was preserved for retry.",
      reason: "llm_timeout",
      nextAction: { type: "retry_stage", label: "Retry draft generation" },
    };
  }
  if (lower.includes("evidence") && (lower.includes("shortage") || lower.includes("insufficient"))) {
    return {
      stage: "evidence_pack",
      status: "needs_input",
      message: "Evidence is insufficient for safe optimization.",
      reason: "evidence_shortage",
      nextAction: { type: "add_experience_evidence", label: "Add stronger experience evidence" },
    };
  }
  if (lower.includes("layout") || lower.includes("overflow") || lower.includes("underfill")) {
    return {
      stage: "layout_check",
      status: "failed",
      message: "Layout validation failed and needs targeted remediation.",
      reason: "layout_failure",
      nextAction: { type: "retry_layout_check", label: "Retry layout check after compacting content" },
    };
  }
  return {
    stage: stage ?? "failed",
    status: "failed",
    message: message || "Resume optimization failed.",
    reason: "workflow_failed",
    nextAction: { type: "retry_stage", label: "Retry the failed stage" },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Resume optimization failed.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
