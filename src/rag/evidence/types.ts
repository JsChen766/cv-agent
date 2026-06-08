import type { ProductExperienceCategory, ProductExperienceSummary } from "../../product/types.js";

export type JDRequirementCategory =
  | "role_positioning"
  | "responsibility"
  | "qualification"
  | "skill"
  | "keyword"
  | "nice_to_have"
  | "constraint";

export type JDRequirementImportance = "critical" | "high" | "medium" | "low";

export type JDRequirementEvidenceType =
  | "direct_match"
  | "keyword_presence"
  | "experience_analogy"
  | "need_user_confirmation";

export type RequirementRetrievalPolicy =
  | "keyword_exact"
  | "structured_skill"
  | "semantic_experience"
  | "claim_verification"
  | "ask_user_required";

export type EvidenceCoverage = "covered" | "partially_covered" | "no_evidence";

export type EvidenceRecommendedAction = "use" | "ask_user" | "ignore" | "alternative_angle";

export type EvidenceQuality = "strong" | "medium" | "weak" | "missing";

export type JDRequirement = {
  id: string;
  text: string;
  category: JDRequirementCategory;
  importance: JDRequirementImportance;
  evidenceType: JDRequirementEvidenceType;
  retrievalPolicies: RequirementRetrievalPolicy[];
  keywords: string[];
};

export type EvidenceRAGExperience = ProductExperienceSummary & {
  tags?: string[];
  content?: string;
  structured?: Record<string, unknown>;
};

export type RetrievedExperience = {
  experience: EvidenceRAGExperience;
  score: number;
  matchedTerms: string[];
  matchedRequirementIds: string[];
  reason: string;
};

export type ClaimRiskLevel = "low" | "medium" | "high";

export type ExperienceClaim = {
  id: string;
  experienceId: string;
  revisionId?: string;
  claim: string;
  evidenceText: string;
  skills: string[];
  confidence: number;
  riskLevel: ClaimRiskLevel;
};

export type EvidenceItem = {
  id: string;
  experienceId: string;
  revisionId?: string;
  title: string;
  category: ProductExperienceCategory | string;
  evidenceText: string;
  skills: string[];
  supportedClaims: string[];
  confidence: number;
  riskLevel: ClaimRiskLevel;
};

export type AllowedClaim = {
  id: string;
  claim: string;
  requirementIds: string[];
  experienceId: string;
  revisionId?: string;
  evidenceText: string;
  confidence: number;
  riskLevel: ClaimRiskLevel;
};

export type EvidenceQualitySignal = {
  requirementId: string;
  quality: EvidenceQuality;
  confidence: number;
  reason: string;
};

export type EvidenceGraphLink = {
  sourceType: "experience" | "claim" | "skill" | "requirement";
  sourceId: string;
  relation:
    | "supports"
    | "demonstrates"
    | "covers"
    | "partially_covers"
    | "requires"
    | "derived_from";
  targetType: "experience" | "claim" | "skill" | "requirement";
  targetId: string;
  confidence: number;
};

export type EvidenceRetrievalTrace = {
  experienceId: string;
  title: string;
  score: number;
  matchedTerms: string[];
  matchedRequirementIds: string[];
  reason: string;
};

export type EvidenceUsageTrace = {
  requirementId: string;
  claimId?: string;
  experienceId?: string;
  evidenceText?: string;
  generatedText?: string;
  status: "available" | "missing" | "needs_user_confirmation";
};

export type EvidencePack = {
  version: "evidence-rag-v1.5";
  jdRequirements: JDRequirement[];
  matchedEvidence: Array<{
    requirementId: string;
    evidenceItems: EvidenceItem[];
    coverage: EvidenceCoverage;
    recommendedAction: EvidenceRecommendedAction;
  }>;
  allowedClaims: AllowedClaim[];
  missingRequirements: Array<{
    requirementId: string;
    requirementText: string;
    reason: string;
    recommendedAction: "ask_user" | "ignore" | "alternative_angle";
  }>;
  retrievalTrace: EvidenceRetrievalTrace[];
  qualitySignals: EvidenceQualitySignal[];
  graphLinks: EvidenceGraphLink[];
  usageTrace: EvidenceUsageTrace[];
};
