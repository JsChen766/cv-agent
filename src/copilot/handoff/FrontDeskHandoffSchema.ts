import { z } from "zod";

export const FrontDeskIntentSchema = z.enum([
  "jd.intake",
  "jd.save",
  "jd.analyze",
  "resume.generate_from_jd",
  "experience.intake",
  "experience.save",
  "experience.rewrite",
  "experience.match_against_jd",
  "asset_grounded.write",
  "resume.optimize_item",
  "resume.export",
  "general.chat",
  "clarify",
]);

export const FrontDeskRouteSchema = z.enum([
  "frontdesk",
  "strategist",
  "experience_receiver",
  "architect",
  "critic",
]);

export const FrontDeskSuggestedActionSchema = z.enum([
  "save_jd",
  "analyze_jd",
  "match_experiences",
  "generate_resume",
  "save_experience",
  "rewrite_experience",
  "optimize_resume_item",
  "compose_career_text",
  "ask_clarification",
]);

/**
 * Phase 1 (asset-grounded writing) additive contract.
 *
 * `outputType` is an internal, optional hint that lets `asset_grounded.write`
 * cover many concrete writing tasks (self_intro / project_intro / cover_letter /
 * interview_answer / application_answer / profile_summary / pitch / custom)
 * WITHOUT exploding the top-level intent enum. Phase 2+ tooling
 * (compose_career_text) will read this hint to shape its prompt; consumers
 * that ignore it still see a valid handoff.
 *
 * Keep it open-ended on the wire (`z.string()`) but expose a typed enum for
 * call-sites that want it. New values are additive and never break the schema.
 */
export const AssetGroundedOutputTypeSchema = z.enum([
  "self_intro",
  "interview_answer",
  "cover_letter",
  "profile_summary",
  "project_intro",
  "application_answer",
  "pitch",
  "custom",
]);

export const AssetGroundedConstraintsSchema = z.object({
  length: z.enum(["short", "medium", "long"]).optional(),
  language: z.enum(["zh", "en", "auto"]).optional(),
  tone: z.string().optional(),
  audience: z.string().optional(),
  format: z.enum(["paragraph", "bullets", "script", "email", "answer"]).optional(),
}).partial();

export const FrontDeskHandoffSchema = z.object({
  id: z.string().min(1),
  turnId: z.string().min(1),
  sessionId: z.string().min(1),
  intent: FrontDeskIntentSchema,
  confidence: z.number().min(0).max(1),
  routeTo: FrontDeskRouteSchema,
  userGoal: z.string().optional(),
  /**
   * Free-form internal goal hint. For asset-grounded writing this typically
   * matches one of `AssetGroundedOutputTypeSchema` values, but we keep it as a
   * plain string so future task families (e.g. summarize, explain) can land
   * here additively without an enum migration.
   */
  goal: z.string().optional(),
  /**
   * Concrete output flavor for asset-grounded writing. Optional and additive;
   * older callers omit it.
   */
  outputType: z.string().optional(),
  /**
   * Optional length / language / tone / audience / format hints that the
   * specialist (Phase 3+) and the writing tool (Phase 2+) can consume.
   */
  constraints: AssetGroundedConstraintsSchema.optional(),
  extracted: z.object({
    jdText: z.string().optional(),
    experienceText: z.string().optional(),
    resumeText: z.string().optional(),
    jdId: z.string().optional(),
    experienceId: z.string().optional(),
    /** Phase 1 additive: list-form for asset-grounded writing scoped to multiple experiences. */
    experienceIds: z.array(z.string()).optional(),
    /** Phase 1 additive: natural-language keyword to be resolved to a canonical id later. */
    experienceQuery: z.string().optional(),
    resumeId: z.string().optional(),
    resumeItemId: z.string().optional(),
    fileId: z.string().optional(),
    resumeFileId: z.string().optional(),
    originalName: z.string().optional(),
    variantId: z.string().optional(),
    title: z.string().optional(),
    company: z.string().optional(),
    targetRole: z.string().optional(),
    location: z.string().optional(),
    requirements: z.array(z.string()).optional(),
    responsibilities: z.array(z.string()).optional(),
    keywords: z.array(z.string()).optional(),
  }).default({}),
  missingInputs: z.array(z.string()).optional(),
  suggestedActions: z.array(FrontDeskSuggestedActionSchema).optional(),
  next: z.enum(["answer_directly", "handoff", "ask_clarification", "prepare_confirmation", "execute_task"]),
  createdAt: z.string().min(1),
  raw: z.record(z.string(), z.unknown()).optional(),
});

export type ParsedFrontDeskHandoff = z.infer<typeof FrontDeskHandoffSchema>;
export type AssetGroundedOutputType = z.infer<typeof AssetGroundedOutputTypeSchema>;
export type AssetGroundedConstraints = z.infer<typeof AssetGroundedConstraintsSchema>;
