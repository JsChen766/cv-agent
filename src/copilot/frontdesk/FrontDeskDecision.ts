import { z } from "zod";

export const FrontDeskModeSchema = z.enum([
  "chat_only",
  "ask_clarification",
  "use_product_tool",
  "generate_resume_variants",
  "explain_workspace",
  "smalltalk",
]);

export type FrontDeskMode = z.infer<typeof FrontDeskModeSchema>;

export const FrontDeskUserIntentSchema = z.enum([
  "general_chat",
  "ask_product_capability",
  "career_advice",
  "add_experience",
  "edit_experience",
  "list_experiences",
  "import_resume",
  "save_jd",
  "list_jds",
  "generate_resume_for_jd",
  "accept_variant",
  "revise_variant",
  "show_evidence",
  "explain_choice",
  "list_resumes",
  "open_resume",
  "unknown",
]);

export type FrontDeskUserIntent = z.infer<typeof FrontDeskUserIntentSchema>;

export const FrontDeskToolNameSchema = z.enum([
  "create_experience",
  "list_experiences",
  "import_resume_text",
  "save_jd",
  "list_jds",
  "create_resume_from_jd",
  "save_variant_to_resume",
  "list_resumes",
  "open_resume",
]);

export type FrontDeskToolName = z.infer<typeof FrontDeskToolNameSchema>;

export const FrontDeskMissingInputSchema = z.enum([
  "resumeText",
  "jdText",
  "targetRole",
  "experienceContent",
  "variantId",
  "resumeId",
]);

export type FrontDeskMissingInput = z.infer<typeof FrontDeskMissingInputSchema>;

export const FrontDeskDecisionSchema = z.object({
  mode: FrontDeskModeSchema,
  intent: FrontDeskUserIntentSchema,
  confidence: z.number().min(0).max(1),
  assistantDraft: z.string(),
  toolCall: z.object({
    name: FrontDeskToolNameSchema,
    arguments: z.record(z.string(), z.unknown()),
  }).optional(),
  missingInputs: z.array(FrontDeskMissingInputSchema).optional(),
  nextActions: z.array(z.object({
    type: z.string(),
    label: z.string(),
  })).optional(),
});

export type FrontDeskDecision = z.infer<typeof FrontDeskDecisionSchema>;

export function parseFrontDeskDecision(value: unknown): FrontDeskDecision {
  return FrontDeskDecisionSchema.parse(value);
}
