import { z } from "zod";
import type {
  ArtifactScores,
  GeneratedArtifact,
  GeneratedArtifactStatus,
  GeneratedArtifactType,
} from "../types.js";

export const GeneratedArtifactTypeSchema = z.enum([
  "resume_bullet",
  "resume_summary",
  "cover_letter_snippet",
]) satisfies z.ZodType<GeneratedArtifactType>;

export const GeneratedArtifactStatusSchema = z.enum([
  "draft",
  "ready",
  "needs_review",
]) satisfies z.ZodType<GeneratedArtifactStatus>;

export const ArtifactScoresSchema = z.object({
  overall: z.number(),
  requirementMatch: z.number(),
  evidenceStrength: z.number(),
}) satisfies z.ZodType<ArtifactScores>;

export const GeneratedArtifactSchema = z.object({
  id: z.string(),
  userId: z.string(),
  type: GeneratedArtifactTypeSchema,
  content: z.string(),
  sourceExperienceIds: z.array(z.string()),
  sourceEvidenceIds: z.array(z.string()),
  matchedSkillIds: z.array(z.string()),
  targetJDId: z.string(),
  targetRequirementIds: z.array(z.string()),
  targetRole: z.string(),
  scores: ArtifactScoresSchema,
  status: GeneratedArtifactStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<GeneratedArtifact>;
