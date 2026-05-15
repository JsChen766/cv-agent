import { z } from "zod";
import type {
  ArtifactCandidateStatus,
  ArtifactClaimRiskLevel,
  ArtifactClaimSupportLevel,
} from "../generators/ArtifactGenerator.js";

export const LLMRevisedArtifactClaimSchema = z.object({
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

export const LLMArtifactRevisionOutputSchema = z.object({
  content: z.string().min(1),
  sourceExperienceIds: z.array(z.string()).default([]),
  sourceEvidenceIds: z.array(z.string()).default([]),
  targetRequirementIds: z.array(z.string()).default([]),
  claims: z.array(LLMRevisedArtifactClaimSchema).min(1),
  status: z.enum(["ready", "needs_confirmation", "unsafe"]) satisfies z.ZodType<ArtifactCandidateStatus>,
  confirmationQuestions: z.array(z.string()).default([]),
  enhancementStrategy: z.enum([
    "evidence_rewrite",
    "reasonable_inference",
    "confirmation_needed",
    "unsafe_candidate",
  ]),
  rationale: z.string().optional(),
  warnings: z.array(z.string()).default([]),
});

export type LLMRevisedArtifactClaim = z.infer<typeof LLMRevisedArtifactClaimSchema>;
export type LLMArtifactRevisionOutput = z.infer<typeof LLMArtifactRevisionOutputSchema>;
