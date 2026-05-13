import { z } from "zod";
import type {
  ExperienceVariant,
  ExperienceVariantStatus,
  ExperienceVariantType,
} from "../types.js";

export const ExperienceVariantTypeSchema = z.enum([
  "resume_bullet",
  "interview_story",
  "summary",
]) satisfies z.ZodType<ExperienceVariantType>;

export const ExperienceVariantStatusSchema = z.enum([
  "draft",
  "active",
  "archived",
]) satisfies z.ZodType<ExperienceVariantStatus>;

export const ExperienceVariantSchema = z.object({
  id: z.string(),
  userId: z.string(),
  experienceId: z.string(),
  type: ExperienceVariantTypeSchema,
  content: z.string(),
  targetJDId: z.string().nullable(),
  targetRole: z.string().nullable(),
  sourceEvidenceIds: z.array(z.string()),
  matchedSkillIds: z.array(z.string()),
  scores: z.record(z.string(), z.number()),
  status: ExperienceVariantStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<ExperienceVariant>;
