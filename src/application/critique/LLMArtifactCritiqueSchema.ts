import { z } from "zod";
import type {
  ArtifactClaimRiskLevel,
  ArtifactClaimSupportLevel,
} from "../generators/ArtifactGenerator.js";
import type { ArtifactCritiqueVerdict } from "./types.js";

export const LLMArtifactClaimReviewSchema = z.object({
  claimText: z.string().min(1),
  supportLevel: z.enum([
    "supported",
    "inferred",
    "needs_user_confirmation",
    "unsupported",
  ]) satisfies z.ZodType<ArtifactClaimSupportLevel>,
  riskLevel: z.enum(["low", "medium", "high"]) satisfies z.ZodType<ArtifactClaimRiskLevel>,
  verdict: z.enum(["pass", "revise", "reject"]) satisfies z.ZodType<ArtifactCritiqueVerdict>,
  reason: z.string().min(1),
  evidenceIds: z.array(z.string()).default([]),
});

export const LLMArtifactCritiqueItemSchema = z.object({
  artifactId: z.string().min(1),
  verdict: z.enum(["pass", "revise", "reject"]) satisfies z.ZodType<ArtifactCritiqueVerdict>,
  truthfulnessRisk: z.enum(["low", "medium", "high"]),
  exaggerationRisk: z.enum(["low", "medium", "high"]),
  specificityScore: z.number().min(0).max(1),
  evidenceStrengthScore: z.number().min(0).max(1),
  unsupportedClaims: z.array(z.string()).default([]),
  missingEvidence: z.array(z.string()).default([]),
  rewriteSuggestions: z.array(z.string()).default([]),
  confirmationQuestions: z.array(z.string()).default([]),
  safeRewriteSuggestion: z.string().optional(),
  claimReviews: z.array(LLMArtifactClaimReviewSchema).default([]),
});

export const LLMArtifactCritiqueOutputSchema = z.object({
  items: z.array(LLMArtifactCritiqueItemSchema).min(1),
  summary: z.string().min(1),
  warnings: z.array(z.string()).default([]),
});

export type LLMArtifactClaimReview = z.infer<typeof LLMArtifactClaimReviewSchema>;
export type LLMArtifactCritiqueItem = z.infer<typeof LLMArtifactCritiqueItemSchema>;
export type LLMArtifactCritiqueOutput = z.infer<typeof LLMArtifactCritiqueOutputSchema>;
