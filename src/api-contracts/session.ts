import type { GenerateResumeResponse } from "./generation.js";
import type {
  ArtifactDecisionType,
  CoverageGapDecisionType,
  GenerationSession,
  GenerationSessionSummary,
} from "../application/sessions/types.js";

export type CreateGenerationSessionRequest = {
  generation: GenerateResumeResponse;
};

export type CreateGenerationSessionResponse = {
  session: GenerationSession;
  summary: GenerationSessionSummary;
};

export type DecideArtifactRequest = {
  artifactId: string;
  decision: Exclude<ArtifactDecisionType, "undecided">;
  note?: string;
};

export type DecideArtifactResponse = {
  session: GenerationSession;
  summary: GenerationSessionSummary;
};

export type DecideCoverageGapRequest = {
  requirementId: string;
  decision: Exclude<CoverageGapDecisionType, "undecided">;
  note?: string;
};

export type DecideCoverageGapResponse = {
  session: GenerationSession;
  summary: GenerationSessionSummary;
};

export type GenerateSupplementalArtifactDraftRequest = {
  requirementId: string;
};

export type GenerateSupplementalArtifactDraftResponse = {
  session: GenerationSession;
  summary: GenerationSessionSummary;
};
