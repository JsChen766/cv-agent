import { z } from "zod";

export const EmptyInputSchema = z.object({}).passthrough();
export const ListInputSchema = z.object({ limit: z.number().int().positive().max(100).optional() }).passthrough();
export const IdInputSchema = z.object({ id: z.string().min(1) }).passthrough();
export const ImportCandidateInputSchema = z.object({
  candidateId: z.string().min(1),
  patch: z.unknown().optional(),
}).passthrough();
export const SearchInputSchema = z.object({ query: z.string().min(1), limit: z.number().int().positive().max(50).optional() }).passthrough();
export const TextInputSchema = z.object({ text: z.string().min(1) }).passthrough();
export const ResumeFileImportInputSchema = z.object({
  fileId: z.string().min(1),
  originalName: z.string().optional(),
  source: z.enum(["resume_upload", "file_upload", "copilot"]).optional(),
}).passthrough();
export const SaveExperienceFromTextInputSchema = z.object({
  text: z.string().optional(),
  candidate: z.unknown().optional(),
  experienceDraft: z.unknown().optional(),
}).passthrough().refine((value) => {
  if (typeof value.text === "string" && value.text.trim().length > 0) return true;
  return value.candidate !== undefined || value.experienceDraft !== undefined;
}, {
  message: "text or candidate is required",
  path: ["text"],
});
export const UpdateExperienceInputSchema = z.object({
  experienceId: z.string().min(1),
  patch: z.unknown().optional().default({}),
  content: z.string().optional(),
}).passthrough();
export const DeleteExperienceInputSchema = z.object({ experienceId: z.string().min(1) }).passthrough();
export const JDInputSchema = z.object({
  text: z.string().min(1),
  title: z.string().optional(),
  company: z.string().optional(),
  targetRole: z.string().optional(),
}).passthrough();
export const GenerateResumeInputSchema = z.object({
  jdId: z.string().optional(),
  jdText: z.string().optional(),
  targetRole: z.string().optional(),
}).passthrough().refine((value) => Boolean(value.jdId?.trim() || value.jdText?.trim()), {
  message: "jdId or jdText is required",
  path: ["jdText"],
});
export const AcceptGenerationVariantInputSchema = z.object({
  generationId: z.string().min(1),
  variantId: z.string().min(1),
  resumeId: z.string().optional(),
}).passthrough();
export const ReviseResumeItemInputSchema = z.object({
  resumeItemId: z.string().min(1),
  instruction: z.string().min(1),
}).passthrough();
export const ExportResumeInputSchema = z.object({
  resumeId: z.string().min(1),
  format: z.enum(["html", "pdf"]).default("html"),
  templateId: z.string().optional(),
}).passthrough();
export const ShowEvidenceInputSchema = z.object({
  id: z.string().optional(),
  variantId: z.string().optional(),
  evidenceId: z.string().optional(),
  evidenceChainId: z.string().optional(),
  generationId: z.string().optional(),
}).passthrough();

/**
 * Phase 2 (asset-grounded writing): input schema for `compose_career_text`.
 *
 * All fields are optional so the model can call the tool with whatever
 * subset of grounding signals is available; the tool itself decides
 * needs_input vs success based on whether enough assets resolved.
 */
export const ComposeCareerTextInputSchema = z.object({
  goal: z.string().optional(),
  userInstruction: z.string().optional(),
  outputType: z.string().optional(),
  assetScope: z.object({
    experienceIds: z.array(z.string()).optional(),
    resumeId: z.string().optional(),
    jdId: z.string().optional(),
  }).partial().optional(),
  experienceQuery: z.string().optional(),
  jdText: z.string().optional(),
  constraints: z.object({
    length: z.enum(["short", "medium", "long"]).optional(),
    language: z.enum(["zh", "en", "auto"]).optional(),
    tone: z.string().optional(),
    audience: z.string().optional(),
    format: z.enum(["paragraph", "bullets", "script", "email", "answer"]).optional(),
  }).partial().optional(),
}).passthrough();

export const ToolResultEntitySchema = z.object({
  type: z.string().min(1),
  id: z.string().optional(),
  title: z.string().optional(),
  data: z.unknown().optional(),
}).passthrough();

export const ToolResultEvidenceSchema = z.object({
  sourceId: z.string().optional(),
  claim: z.string().optional(),
  support: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
}).passthrough();

export const ToolResultNextActionHintSchema = z.object({
  type: z.string().min(1),
  label: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const ToolResultSchema = z.object({
  status: z.enum(["success", "needs_input", "failed"]),
  message: z.string().optional(),
  data: z.unknown().optional(),
  workspacePatch: z.record(z.string(), z.unknown()).optional(),
  actionResult: z.record(z.string(), z.unknown()).optional(),
  pendingActionId: z.string().optional(),
  visibility: z.enum(["internal", "user_summary", "action_required", "error_user_visible"]).optional(),

  // Phase 1 structured fields (all optional). See ToolResult.ts for rationale.
  resultKind: z.string().optional(),
  summaryFacts: z.array(z.string()).optional(),
  entities: z.array(ToolResultEntitySchema).optional(),
  evidence: z.array(ToolResultEvidenceSchema).optional(),
  warnings: z.array(z.string()).optional(),
  nextActionHints: z.array(ToolResultNextActionHintSchema).optional(),
});
