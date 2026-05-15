import { z } from "zod";
import type {
  ArtifactCandidateStatus,
  ArtifactClaimRiskLevel,
  ArtifactClaimSupportLevel,
} from "./ArtifactGenerator.js";

export const LLMGeneratedArtifactClaimSchema = z.object({
  text: z.string().min(1),
  supportLevel: z.enum([
    "supported",
    "inferred",
    "needs_user_confirmation",
    "unsupported",
  ]) satisfies z.ZodType<ArtifactClaimSupportLevel>,
  riskLevel: z.enum(["low", "medium", "high"]) satisfies z.ZodType<ArtifactClaimRiskLevel>,
  evidenceIds: z.array(z.string()).default([]),
  sourceExperienceIds: z.array(z.string()).default([]),
  userConfirmationPrompt: z.string().optional(),
});

export const LLMGeneratedArtifactSchema = z.object({
  content: z.string().min(1),
  targetRequirementIds: z.array(z.string()).default([]),
  sourceExperienceIds: z.array(z.string()).default([]),
  sourceEvidenceIds: z.array(z.string()).default([]),
  claims: z.array(LLMGeneratedArtifactClaimSchema).min(1),
  status: z.enum(["ready", "needs_confirmation", "unsafe"]) satisfies z.ZodType<ArtifactCandidateStatus>,
  confirmationQuestions: z.array(z.string()).default([]),
  enhancementStrategy: z.enum([
    "evidence_rewrite",
    "reasonable_inference",
    "confirmation_needed",
    "unsafe_candidate",
  ]),
  rationale: z.string().optional(),
});

export const LLMArtifactGenerationOutputSchema = z.object({
  artifacts: z.array(LLMGeneratedArtifactSchema).min(1),
  warnings: z.array(z.string()).default([]),
});

export type LLMGeneratedArtifactClaim = z.infer<typeof LLMGeneratedArtifactClaimSchema>;
export type LLMGeneratedArtifact = z.infer<typeof LLMGeneratedArtifactSchema>;
export type LLMArtifactGenerationOutput = z.infer<typeof LLMArtifactGenerationOutputSchema>;
