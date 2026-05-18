import { z } from "zod";

export const panelEnum = z.enum(["variants", "experience_library", "resume_history", "resume_editor", "jd_library", "import_candidates"]);

export const revisionInstructionSchema = z.enum([
  "make_more_conservative",
  "remove_unsupported_claims",
  "apply_user_confirmation",
  "make_more_quantified",
  "align_to_requirement",
  "rewrite_for_tone",
  "custom",
]);

export function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}
