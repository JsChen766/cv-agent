import type {
  Evidence,
  Experience,
  GeneratedArtifact,
  JDRequirement,
  Skill,
} from "../../knowledge/types.js";
import type { RetrievedExperience } from "../../knowledge/retrieval/ExperienceRetriever.js";

export type ArtifactClaimSupportLevel =
  | "supported"
  | "inferred"
  | "needs_user_confirmation"
  | "unsupported";

export type ArtifactClaimRiskLevel =
  | "low"
  | "medium"
  | "high";

export type ArtifactCandidateStatus =
  | "ready"
  | "needs_confirmation"
  | "unsafe";

export type ArtifactClaim = {
  text: string;
  supportLevel: ArtifactClaimSupportLevel;
  riskLevel: ArtifactClaimRiskLevel;
  evidenceIds: string[];
  sourceExperienceIds: string[];
  userConfirmationPrompt?: string;
};

export type ArtifactEnhancementMetadata = {
  status: ArtifactCandidateStatus;
  claims: ArtifactClaim[];
  confirmationQuestions: string[];
  enhancementStrategy:
    | "evidence_rewrite"
    | "reasonable_inference"
    | "confirmation_needed"
    | "unsafe_candidate";
};

export type GenerateArtifactsInput = {
  userId: string;
  jdId: string;
  jdText: string;
  targetRole: string;
  requirements: JDRequirement[];
  experiences?: Experience[];
  evidences?: Evidence[];
  skills?: Skill[];
  retrievedExperiences: RetrievedExperience[];
};

export type GenerateArtifactsResult = {
  artifacts: GeneratedArtifact[];
  warnings: string[];
};

export interface ArtifactGenerator {
  generate(input: GenerateArtifactsInput): Promise<GenerateArtifactsResult>;
}
