import { z } from "zod";

export const EmptyInputSchema = z.object({}).passthrough();
export const ListInputSchema = z.object({ limit: z.number().int().positive().max(100).optional() }).passthrough();
export const IdInputSchema = z.object({ id: z.string().min(1) }).passthrough();
export const SearchInputSchema = z.object({ query: z.string().min(1), limit: z.number().int().positive().max(50).optional() }).passthrough();
export const TextInputSchema = z.object({ text: z.string().min(1) }).passthrough();
export const UpdateExperienceInputSchema = z.object({
  experienceId: z.string().min(1),
  patch: z.record(z.string(), z.unknown()).default({}),
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

export const ToolResultSchema = z.object({
  status: z.enum(["success", "needs_input", "failed"]),
  message: z.string().optional(),
  data: z.unknown().optional(),
  workspacePatch: z.record(z.string(), z.unknown()).optional(),
  actionResult: z.record(z.string(), z.unknown()).optional(),
  pendingActionId: z.string().optional(),
});
