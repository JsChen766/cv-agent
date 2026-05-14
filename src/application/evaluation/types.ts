import type {
  EvidenceChain,
  GeneratedArtifact,
  JDRequirement,
} from "../../knowledge/types.js";
import type { RetrievedExperience } from "../../knowledge/retrieval/ExperienceRetriever.js";

export type RequirementCoverageStatus =
  | "covered"
  | "weakly_covered"
  | "evidence_available_but_not_used"
  | "no_evidence"
  | "not_targeted";

export type RequirementCoverageItem = {
  requirement: JDRequirement;
  status: RequirementCoverageStatus;
  coveredByArtifactIds: string[];
  supportingEvidenceIds: string[];
  supportingSkillIds: string[];
  reason: string;
  suggestions: string[];
};

export type ArtifactCoverageReport = {
  id: string;
  jdId: string;
  userId: string;
  totalRequirements: number;
  coveredRequirementIds: string[];
  weaklyCoveredRequirementIds: string[];
  evidenceAvailableButNotUsedRequirementIds: string[];
  noEvidenceRequirementIds: string[];
  notTargetedRequirementIds: string[];
  items: RequirementCoverageItem[];
  summary: string;
  createdAt: string;
};

export type EvaluateArtifactCoverageInput = {
  userId: string;
  jdId: string;
  requirements: JDRequirement[];
  retrievedExperiences: RetrievedExperience[];
  artifacts: GeneratedArtifact[];
  evidenceChains: EvidenceChain[];
};
