import { z } from "zod";

// ═══════════════════════════════════════════════════════════════
// Base schemas for common ToolResult sub-structures.
// These describe the de-facto contract of current tool outputs,
// not an aspirational ideal. They are validated in tests only.
// ═══════════════════════════════════════════════════════════════

/**
 * Common workspacePatch fields shared across tool outputs.
 * Uses .passthrough() to allow tool-specific additional fields.
 */
export const BaseWorkspacePatchSchema = z.object({
  activePanel: z.string().optional(),
}).passthrough();

/**
 * Common actionResult fields shared across tool outputs.
 */
export const BaseActionResultSchema = z.object({
  status: z.enum(["success", "needs_input"]).optional(),
  actionType: z.string().optional(),
  reason: z.string().optional(),
  message: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

/**
 * Base ToolResult shape — mirrors the current ToolResultSchema
 * but with slightly more structured sub-fields for contract testing.
 */
export const BaseToolResultSchema = z.object({
  status: z.enum(["success", "needs_input", "failed"]),
  message: z.string().optional(),
  data: z.unknown().optional(),
  workspacePatch: BaseWorkspacePatchSchema.optional(),
  actionResult: BaseActionResultSchema.optional(),
  pendingActionId: z.string().optional(),
  visibility: z.enum(["internal", "user_summary", "action_required", "error_user_visible"]).optional(),
}).passthrough();

// ═══════════════════════════════════════════════════════════════
// Typed output schemas for individual tools.
// Each describes the ACTUAL return shape of the tool as of today.
// ═══════════════════════════════════════════════════════════════

/**
 * list_resumes — returns { count, items } in data,
 * workspacePatch { activePanel: "resume_history", resumes: [...] }.
 */
export const ListResumesOutputSchema = BaseToolResultSchema.extend({
  data: z.object({
    count: z.number(),
    items: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        targetRole: z.string().optional(),
        jdId: z.string().optional(),
        status: z.string(),
      }).passthrough(),
    ),
  }).passthrough().optional(),
  workspacePatch: z.object({
    activePanel: z.literal("resume_history"),
    resumes: z.array(z.unknown()),
  }).passthrough().optional(),
}).passthrough();

/**
 * get_resume — returns { resume } in data on success,
 * or { id } on failure.
 * workspacePatch (success): { activePanel: "resume_editor", resumeId, activeResume, active }.
 */
export const GetResumeOutputSchema = BaseToolResultSchema.extend({
  data: z.union([
    z.object({ resume: z.record(z.string(), z.unknown()) }).passthrough(),
    z.object({ id: z.string() }).passthrough(),
  ]).optional(),
  workspacePatch: z.object({
    activePanel: z.literal("resume_editor"),
    resumeId: z.string(),
    activeResume: z.record(z.string(), z.unknown()),
    active: z.object({ resumeId: z.string() }).passthrough(),
  }).passthrough().optional(),
}).passthrough();

// ── Resume write tools ───────────────────────────────────────────

const RevisionSuggestion = z.object({
  kind: z.literal("resume_item"),
  sourceId: z.string(),
  sourceTextPreview: z.string().optional(),
  rewrittenText: z.string(),
  usedModel: z.boolean(),
  changes: z.array(z.unknown()).optional(),
}).passthrough();

/**
 * accept_generation_variant — success path only.
 */
export const AcceptGenerationVariantOutputSchema = BaseToolResultSchema.extend({
  status: z.literal("success"),
  data: z.object({
    generation: z.record(z.string(), z.unknown()),
    resume: z.record(z.string(), z.unknown()),
    item: z.record(z.string(), z.unknown()),
    variant: z.record(z.string(), z.unknown()),
  }).passthrough(),
  workspacePatch: z.object({
    activePanel: z.literal("resume_editor"),
    resumeId: z.string(),
    activeResume: z.unknown(),
    active: z.object({ resumeId: z.string() }).passthrough(),
    status: z.literal("accepted"),
  }).passthrough(),
  actionResult: z.object({
    status: z.literal("success"),
    actionType: z.literal("accept_generation_variant"),
    variantId: z.string(),
    metadata: z.object({
      generationId: z.string(),
      resumeId: z.string(),
    }).passthrough(),
  }).passthrough(),
  visibility: z.literal("user_summary"),
}).passthrough();

/**
 * prepare_revise_resume_item — union of success (with revisionSuggestion)
 * and needs_input paths.
 */
const PrepareReviseSuccessResult = z.object({
  status: z.literal("success"),
  message: z.string(),
  data: z.object({
    resumeItemId: z.string(),
    instruction: z.string().optional(),
    sourceTextPreview: z.string().optional(),
    rewrittenText: z.string(),
  }).passthrough(),
  visibility: z.literal("user_summary"),
  actionResult: z.object({
    status: z.literal("success"),
    actionType: z.literal("prepare_revise_resume_item"),
    revisionSuggestion: RevisionSuggestion,
    metadata: z.object({
      nextAction: z.literal("revise_resume_item"),
      requiresConfirmation: z.literal(true),
      usedModel: z.boolean(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

const PrepareReviseNeedsInputResult = z.object({
  status: z.literal("needs_input"),
  message: z.string(),
  data: z.object({
    resumeItemId: z.string(),
    instruction: z.string().optional(),
  }).passthrough(),
  visibility: z.literal("error_user_visible"),
  actionResult: z.object({
    status: z.literal("needs_input"),
    actionType: z.literal("prepare_revise_resume_item"),
    reason: z.enum(["source_text_not_found", "model_not_available", "model_call_failed"]),
  }).passthrough(),
}).passthrough();

export const PrepareReviseResumeItemOutputSchema = z.union([
  PrepareReviseSuccessResult,
  PrepareReviseNeedsInputResult,
]);

/**
 * revise_resume_item — union of success, needs_input, and failed paths.
 */
const ReviseResumeItemSuccessResult = z.object({
  status: z.literal("success"),
  message: z.string(),
  data: z.object({
    item: z.record(z.string(), z.unknown()),
    rewrittenText: z.string(),
  }).passthrough(),
  workspacePatch: z.object({
    activePanel: z.literal("resume_editor"),
  }).passthrough(),
  visibility: z.literal("user_summary"),
  actionResult: z.object({
    status: z.literal("success"),
    actionType: z.literal("optimize_resume_item"),
    revisionSuggestion: RevisionSuggestion,
  }).passthrough(),
}).passthrough();

const ReviseResumeItemNeedsInputResult = z.object({
  status: z.literal("needs_input"),
  message: z.string(),
  data: z.object({
    resumeItemId: z.string().optional(),
  }).passthrough().optional(),
  visibility: z.literal("error_user_visible"),
  actionResult: z.object({
    status: z.literal("needs_input"),
    actionType: z.enum(["revise_resume_item", "optimize_resume_item"]),
    reason: z.enum(["source_text_not_found", "no_rewritten_text"]),
    message: z.string().optional(),
  }).passthrough(),
}).passthrough();

const ReviseResumeItemFailedResult = z.object({
  status: z.literal("failed"),
  message: z.string(),
  data: z.object({ id: z.string() }).passthrough(),
  visibility: z.literal("error_user_visible"),
}).passthrough();

export const ReviseResumeItemOutputSchema = z.union([
  ReviseResumeItemSuccessResult,
  ReviseResumeItemNeedsInputResult,
  ReviseResumeItemFailedResult,
]);
