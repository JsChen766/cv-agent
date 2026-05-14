import { z } from "zod";

export const CreateGenerationSessionInputSchema = z.object({
  generation: z.object({
    userId: z.string().min(1),
    jdId: z.string().min(1),
    artifacts: z.array(z.unknown()),
  }).passthrough(),
});

export const DecideArtifactInputSchema = z.object({
  sessionId: z.string().min(1),
  artifactId: z.string().min(1),
  decision: z.enum(["accepted", "rejected", "needs_revision"]),
  note: z.string().optional(),
});

export const DecideCoverageGapInputSchema = z.object({
  sessionId: z.string().min(1),
  requirementId: z.string().min(1),
  decision: z.enum([
    "generate_supplemental_artifact",
    "request_more_evidence",
    "ignore",
    "mark_not_relevant",
  ]),
  note: z.string().optional(),
});

export const GenerateSupplementalArtifactDraftInputSchema = z.object({
  sessionId: z.string().min(1),
  requirementId: z.string().min(1),
});
