import { z } from "zod";

export const LLMExtractedEvidenceSchema = z.object({
  excerpt: z.string().min(1),
  evidenceType: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  skillNames: z.array(z.string()).optional(),
});

export const LLMExtractedSkillSchema = z.object({
  name: z.string().min(1),
  category: z.string().optional(),
});

export const LLMExtractedExperienceSchema = z.object({
  type: z.string().optional(),
  organization: z.string().optional(),
  role: z.string().optional(),
  summary: z.string().min(1),
  timeRange: z.object({
    start: z.string().optional(),
    end: z.string().optional(),
  }).optional(),
  star: z.object({
    situation: z.string().optional(),
    task: z.string().optional(),
    action: z.string().optional(),
    result: z.string().optional(),
  }).optional(),
  evidences: z.array(LLMExtractedEvidenceSchema).default([]),
  skills: z.array(LLMExtractedSkillSchema).default([]),
});

export const LLMExperienceExtractionOutputSchema = z.object({
  experiences: z.array(LLMExtractedExperienceSchema).min(1),
  warnings: z.array(z.string()).default([]),
});

export type LLMExperienceExtractionOutput = z.infer<typeof LLMExperienceExtractionOutputSchema>;
export type LLMExtractedExperience = z.infer<typeof LLMExtractedExperienceSchema>;
