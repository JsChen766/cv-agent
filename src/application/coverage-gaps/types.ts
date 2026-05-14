import type {
  GeneratedArtifact,
  JDRequirement,
  RiskLevel,
} from "../../knowledge/types.js";
import type { RetrievedExperience } from "../../knowledge/retrieval/ExperienceRetriever.js";
import type { ArtifactCoverageReport } from "../evaluation/types.js";

export type CoverageGapType =
  | "missing_artifact"
  | "missing_evidence"
  | "weak_coverage";

export type CoverageGapSeverity = "low" | "medium" | "high";

export type SupplementalArtifactSuggestion = {
  type: "resume_bullet" | "resume_summary" | "cover_letter_snippet";
  content: string;
  sourceExperienceIds: string[];
  sourceEvidenceIds: string[];
  matchedSkillIds: string[];
  targetRequirementIds: string[];
  confidence: number;
  riskLevel: RiskLevel;
  rationale: string;
};

export type EvidenceRequestSuggestion = {
  prompt: string;
  expectedEvidenceType:
    | "project"
    | "metric"
    | "collaboration"
    | "leadership"
    | "business_impact"
    | "technical_detail"
    | "other";
  reason: string;
};

export type CoverageGapItem = {
  requirement: JDRequirement;
  gapType: CoverageGapType;
  severity: CoverageGapSeverity;
  existingEvidenceIds: string[];
  existingArtifactIds: string[];
  supplementalArtifactSuggestions: SupplementalArtifactSuggestion[];
  evidenceRequestSuggestions: EvidenceRequestSuggestion[];
  reason: string;
};

export type CoverageGapReport = {
  id: string;
  userId: string;
  jdId: string;
  items: CoverageGapItem[];
  supplementalArtifactCount: number;
  evidenceRequestCount: number;
  summary: string;
  createdAt: string;
};

export type AdviseCoverageGapsInput = {
  userId: string;
  jdId: string;
  coverageReport: ArtifactCoverageReport;
  retrievedExperiences: RetrievedExperience[];
  artifacts: GeneratedArtifact[];
};
