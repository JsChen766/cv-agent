import type { GenerateResumeResponse } from "../../api-contracts/generation.js";
import type { GeneratedArtifact } from "../../knowledge/types.js";
import type { SupplementalArtifactSuggestion } from "../coverage-gaps/types.js";

export type ArtifactDecisionType =
  | "accepted"
  | "rejected"
  | "needs_revision"
  | "undecided";

export type CoverageGapDecisionType =
  | "generate_supplemental_artifact"
  | "request_more_evidence"
  | "ignore"
  | "mark_not_relevant"
  | "undecided";

export type ArtifactDecision = {
  artifactId: string;
  decision: ArtifactDecisionType;
  note?: string;
  decidedAt: string;
};

export type CoverageGapDecision = {
  requirementId: string;
  decision: CoverageGapDecisionType;
  note?: string;
  decidedAt: string;
};

export type SupplementalArtifactDraft = {
  id: string;
  requirementId: string;
  sourceSuggestion: SupplementalArtifactSuggestion;
  artifact: GeneratedArtifact;
  status: "draft";
  createdAt: string;
};

export type GenerationSessionStatus =
  | "active"
  | "completed"
  | "archived";

export type GenerationSession = {
  id: string;
  userId: string;
  jdId: string;
  generation: GenerateResumeResponse;
  artifactDecisions: ArtifactDecision[];
  coverageGapDecisions: CoverageGapDecision[];
  supplementalArtifactDrafts: SupplementalArtifactDraft[];
  status: GenerationSessionStatus;
  createdAt: string;
  updatedAt: string;
};

export type GenerationSessionSummary = {
  sessionId: string;
  userId: string;
  jdId: string;
  totalArtifacts: number;
  acceptedArtifacts: number;
  rejectedArtifacts: number;
  needsRevisionArtifacts: number;
  undecidedArtifacts: number;
  totalCoverageGaps: number;
  supplementalArtifactRequests: number;
  moreEvidenceRequests: number;
  ignoredGaps: number;
  notRelevantGaps: number;
  undecidedGaps: number;
  supplementalDraftCount: number;
  status: GenerationSessionStatus;
  updatedAt: string;
};
