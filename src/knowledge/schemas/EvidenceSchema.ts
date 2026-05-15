import { z } from "zod";
import type {
  Evidence,
  EvidenceSourceType,
  EvidenceType,
} from "../types.js";

export const EvidenceSourceTypeSchema = z.enum([
  "raw_input",
  "resume",
  "interview_note",
  "portfolio",
  "manual",
]) satisfies z.ZodType<EvidenceSourceType>;

export const EvidenceTypeSchema = z.enum([
  "bullet",
  "metric",
  "project",
  "skill",
  "outcome",
  "scope",
  "action",
  "result",
  "skill_proof",
  "raw_excerpt",
]) satisfies z.ZodType<EvidenceType>;

export const EvidenceSchema = z.object({
  id: z.string(),
  userId: z.string(),
  experienceId: z.string(),
  sourceType: EvidenceSourceTypeSchema,
  evidenceType: EvidenceTypeSchema,
  sourceRef: z.string(),
  excerpt: z.string(),
  confidence: z.number(),
  sourceDocumentId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string(),
}) satisfies z.ZodType<Evidence>;
