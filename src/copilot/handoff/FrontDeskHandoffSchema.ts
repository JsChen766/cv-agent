import { z } from "zod";

export const FrontDeskIntentSchema = z.enum([
  "jd.intake",
  "jd.save",
  "jd.analyze",
  "resume.generate_from_jd",
  "experience.intake",
  "experience.save",
  "experience.rewrite",
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
  "ask_clarification",
]);

export const FrontDeskHandoffSchema = z.object({
  id: z.string().min(1),
  turnId: z.string().min(1),
  sessionId: z.string().min(1),
  intent: FrontDeskIntentSchema,
  confidence: z.number().min(0).max(1),
  routeTo: FrontDeskRouteSchema,
  userGoal: z.string().optional(),
  extracted: z.object({
    jdText: z.string().optional(),
    experienceText: z.string().optional(),
    resumeText: z.string().optional(),
    jdId: z.string().optional(),
    experienceId: z.string().optional(),
    resumeId: z.string().optional(),
    resumeItemId: z.string().optional(),
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
