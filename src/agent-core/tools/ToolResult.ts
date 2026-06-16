import type { ToolResultVisibility } from "../../copilot/response/ToolResultVisibility.js";

export type ToolResultStatus = "success" | "needs_input" | "failed";

/**
 * Structured fact / entity / evidence / hint shapes used by tools to expose
 * machine-readable context alongside the legacy `message` / `data` /
 * `workspacePatch` / `actionResult` payload. These are introduced in Phase 1
 * of the agent revamp (see docs/cv_agent_next_stage_plan.md) and are all
 * **optional** — every existing consumer continues to work without them.
 *
 * Phase 2 (Narrator/Presenter) will read these fields to compose natural
 * replies. Phase 9 (contract整理) will surface them in the public contract.
 */
export type ToolResultEntity = {
  /** Entity type, e.g. "generation" | "variant" | "experience" | "jd" | "resume" | "export". */
  type: string;
  /** Domain id (variantId, generationId, exportId, …) when applicable. */
  id?: string;
  /** Short human-readable label / title. */
  title?: string;
  /** Tool-specific structured data. Treat as opaque on the consumer side. */
  data?: unknown;
};

export type ToolResultEvidence = {
  /** Backing source id (e.g. experienceId / requirementId). */
  sourceId?: string;
  /** A claim asserted by the tool. */
  claim?: string;
  /** Why the source supports the claim. */
  support?: string;
  /** Tool-reported confidence in [0, 1]. */
  confidence?: number;
};

export type ToolResultNextActionHint = {
  /**
   * Hint kind. Free-form for now; common values are tool names
   * ("accept_generation_variant", "export_resume") or product action types
   * ("review_matches", "open_resume_editor").
   */
  type: string;
  /** Short user-facing label. Narrator may rephrase before showing. */
  label: string;
  /** Optional payload that downstream call sites can replay verbatim. */
  payload?: Record<string, unknown>;
};

export type ToolResult = {
  status: ToolResultStatus;
  message?: string;
  data?: unknown;
  workspacePatch?: Record<string, unknown>;
  actionResult?: Record<string, unknown>;
  pendingActionId?: string;
  visibility?: ToolResultVisibility;

  // ── Phase 1 structured fields (all optional, additive) ──────────────────
  /**
   * Coarse-grained "kind" of result, e.g. "generation_completed" |
   * "match_completed" | "export_pending" | "export_ready" |
   * "variant_accepted" | "needs_input". Useful for Narrator branching.
   */
  resultKind?: string;
  /**
   * Short, model-friendly bullet facts derived from the tool's actual output
   * (counts, ids, key decisions). NOT user-facing prose — the Narrator may
   * compose them into prose later.
   */
  summaryFacts?: string[];
  /** Entities involved in the result (variants, jd, resume, exportRecord, …). */
  entities?: ToolResultEntity[];
  /** Evidence items supporting the result's claims. */
  evidence?: ToolResultEvidence[];
  /** Non-fatal warnings the user should be aware of (low coverage, fallbacks, …). */
  warnings?: string[];
  /** Suggested follow-up actions for the user / Narrator. */
  nextActionHints?: ToolResultNextActionHint[];
};
