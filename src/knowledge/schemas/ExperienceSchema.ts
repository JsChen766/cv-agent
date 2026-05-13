import { z } from "zod";
import type { Experience, ExperienceType, Star, TimeRange } from "../types.js";

export const ExperienceTypeSchema = z.enum([
  "work",
  "project",
  "education",
  "volunteer",
  "other",
]) satisfies z.ZodType<ExperienceType>;

export const TimeRangeSchema = z.object({
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
}) satisfies z.ZodType<TimeRange>;

export const StarSchema = z.object({
  situation: z.string(),
  task: z.string(),
  action: z.string(),
  result: z.string(),
}) satisfies z.ZodType<Star>;

export const ExperienceSchema = z.object({
  id: z.string(),
  userId: z.string(),
  type: ExperienceTypeSchema,
  organization: z.string(),
  role: z.string(),
  summary: z.string(),
  timeRange: TimeRangeSchema,
  star: StarSchema,
  evidenceIds: z.array(z.string()),
  skillIds: z.array(z.string()),
  confidence: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<Experience>;
