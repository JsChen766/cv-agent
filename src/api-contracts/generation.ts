import type { RetrievedExperience } from "../knowledge/retrieval/ExperienceRetriever.js";
import type {
  EvidenceChain,
  GeneratedArtifact,
  GraphView,
  JDRequirement,
} from "../knowledge/types.js";

export type GenerateResumeRequest = {
  userId: string;
  jdText: string;
  targetRole: string;
};

export type GeneratedArtifactBundle = {
  artifact: GeneratedArtifact;
  evidenceChain: EvidenceChain;
  graphView: GraphView;
};

export type GenerateResumeResponse = {
  userId: string;
  jdId: string;
  jdText: string;
  targetRole: string;
  requirements: JDRequirement[];
  retrievedExperiences: RetrievedExperience[];
  artifacts: GeneratedArtifactBundle[];
  createdAt: string;
};
