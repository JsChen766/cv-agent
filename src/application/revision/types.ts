import type {
  ArtifactCritiqueItem,
} from "../critique/types.js";
import type {
  EvidenceChain,
  GeneratedArtifact,
} from "../../knowledge/types.js";

export type RevisionInstruction =
  | "make_more_conservative"
  | "remove_unsupported_claims"
  | "apply_user_confirmation"
  | "make_more_quantified"
  | "align_to_requirement"
  | "rewrite_for_tone"
  | "custom";

export type RevisionTone =
  | "professional"
  | "concise"
  | "impactful"
  | "conservative"
  | "technical";

export type UserConfirmation = {
  claimText?: string;
  metric?: string;
  value?: string;
  explanation?: string;
};

export type ArtifactRevisionInput = {
  userId: string;
  jdId?: string;
  artifact: GeneratedArtifact;
  critiqueItem?: ArtifactCritiqueItem;
  evidenceChain?: EvidenceChain;
  instruction: RevisionInstruction;
  customInstruction?: string;
  targetRequirementIds?: string[];
  userConfirmations?: UserConfirmation[];
  tone?: RevisionTone;
};

export type ArtifactRevisionResult = {
  originalArtifact: GeneratedArtifact;
  revisedArtifact: GeneratedArtifact;
  warnings: string[];
};

export interface ArtifactRevisionAgent {
  revise(input: ArtifactRevisionInput): Promise<ArtifactRevisionResult>;
}
