import type {
  EvidenceChain,
  GeneratedArtifact,
  GeneratedArtifactStatus,
  GeneratedArtifactType,
  GraphView,
  RiskLevel,
} from "../knowledge/types.js";

export type GetArtifactEvidenceResponse = {
  artifact: GeneratedArtifact;
  evidenceChain: EvidenceChain;
  graphView: GraphView;
};

export type ArtifactListItem = {
  id: string;
  type: GeneratedArtifactType;
  content: string;
  status: GeneratedArtifactStatus;
  score: number;
  evidenceStrength: number;
  riskLevel: RiskLevel;
  sourceExperienceCount: number;
  sourceEvidenceCount: number;
  createdAt: string;
};
