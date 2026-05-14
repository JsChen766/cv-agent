import type { RetrievedExperience } from "../knowledge/retrieval/ExperienceRetriever.js";
import type { ArtifactCritiqueReport } from "../application/critique/types.js";
import type { CoverageGapReport } from "../application/coverage-gaps/types.js";
import type { ArtifactCoverageReport } from "../application/evaluation/types.js";
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
  coverageReport: ArtifactCoverageReport;
  coverageGapReport: CoverageGapReport;
  critiqueReport: ArtifactCritiqueReport;
  createdAt: string;
};
