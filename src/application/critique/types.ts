import type {
  EvidenceChain,
  GeneratedArtifact,
  RiskLevel,
} from "../../knowledge/types.js";
import type {
  ArtifactClaimRiskLevel,
  ArtifactClaimSupportLevel,
} from "../generators/ArtifactGenerator.js";
import type { ArtifactCoverageReport } from "../evaluation/types.js";

export type ArtifactCritiqueVerdict = "pass" | "revise" | "reject";

export type ArtifactCritiqueItem = {
  artifactId: string;
  verdict: ArtifactCritiqueVerdict;
  truthfulnessRisk: RiskLevel;
  exaggerationRisk: RiskLevel;
  specificityScore: number;
  evidenceStrengthScore: number;
  unsupportedClaims: string[];
  missingEvidence: string[];
  rewriteSuggestions: string[];
  confirmationQuestions?: string[];
  claimReviews?: Array<{
    claimText: string;
    supportLevel: ArtifactClaimSupportLevel;
    riskLevel: ArtifactClaimRiskLevel;
    verdict: ArtifactCritiqueVerdict;
    reason: string;
    evidenceIds: string[];
  }>;
  safeRewriteSuggestion?: string;
};

export type ArtifactCritiqueReport = {
  id: string;
  userId: string;
  jdId: string;
  items: ArtifactCritiqueItem[];
  summary: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

export type CritiqueArtifactsInput = {
  userId: string;
  jdId: string;
  artifacts: GeneratedArtifact[];
  evidenceChains: EvidenceChain[];
  coverageReport: ArtifactCoverageReport;
};

export interface ArtifactCritic {
  critique(input: CritiqueArtifactsInput): Promise<ArtifactCritiqueReport>;
}
