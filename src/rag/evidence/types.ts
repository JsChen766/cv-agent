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
export type ClaimStatus = "active" | "stale" | "superseded" | "archived";
export type PersistentGraphNodeType = "experience" | "claim" | "skill" | "requirement";

export type PersistentGraphRelation =
  | "supports"
  | "demonstrates"
  | "covers"
  | "partially_covers"
  | "requires"
  | "derived_from";

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

export type ProductExperienceClaim = ExperienceClaim & {
  userId: string;
  claimType: "achievement" | "responsibility" | "skill" | "education" | "award" | "general";
  status: ClaimStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ProductEvidenceGraphEdge = {
  id: string;
  userId: string;
  sourceType: PersistentGraphNodeType;
  sourceId: string;
  relation: PersistentGraphRelation;
  targetType: PersistentGraphNodeType;
  targetId: string;
  confidence: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type RetrievedPersistentClaim = {
  claim: ProductExperienceClaim;
  score: number;
  matchedTerms: string[];
  matchedRequirementIds: string[];
  reason: string;
  graphEdgeIds?: string[];
};

export type EvidenceItem = {
  id: string;
  claimId?: string;
  claimStatus?: ClaimStatus;
  graphEdgeIds?: string[];
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
  claimId?: string;
  claimStatus?: ClaimStatus;
  graphEdgeIds?: string[];
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
  sourceType: PersistentGraphNodeType;
  sourceId: string;
  relation: PersistentGraphRelation;
  targetType: PersistentGraphNodeType;
  targetId: string;
  confidence: number;
};

export type EvidenceRetrievalTrace = {
  source: "raw_experience" | "persistent_claim";
  experienceId: string;
  claimId?: string;
  graphEdgeIds?: string[];
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
  version: "evidence-rag-v1.5" | "evidence-rag-v2" | "evidence-rag-v4";
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
  longTermMemory?: EvidenceLongTermMemory;
};

export type EvidenceMemoryAction = "generated" | "accepted" | "edited" | "rejected" | "ignored" | "outcome_feedback";

export type EvidenceUsageRecord = {
  id: string;
  userId: string;
  generationId?: string;
  variantId?: string;
  resumeId?: string;
  jdId?: string;
  targetRole?: string;
  roleFamily?: string;
  requirementId: string;
  claimId?: string;
  experienceId?: string;
  evidenceText?: string;
  generatedText?: string;
  finalText?: string;
  action: EvidenceMemoryAction;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ClaimUsageStats = {
  claimId: string;
  experienceId?: string;
  generatedCount: number;
  acceptedCount: number;
  editedCount: number;
  rejectedCount: number;
  ignoredCount: number;
  acceptanceRate: number;
  editRate: number;
  lastUsedAt?: string;
};

export type RoleSpecificClaimEffectiveness = {
  roleFamily: string;
  claimId: string;
  experienceId?: string;
  generatedCount: number;
  acceptedCount: number;
  editedCount: number;
  outcomePositiveCount: number;
  effectivenessScore: number;
};

export type EvidenceOutcomeFeedback = {
  id: string;
  userId: string;
  generationId?: string;
  resumeId?: string;
  jdId?: string;
  targetRole?: string;
  roleFamily?: string;
  outcome: "interview" | "rejection" | "offer" | "no_response" | "other";
  notes?: string;
  relatedClaimIds: string[];
  relatedExperienceIds: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type EvidenceLongTermMemory = {
  claimUsageStats: ClaimUsageStats[];
  roleSpecificEffectiveness: RoleSpecificClaimEffectiveness[];
  outcomeFeedback: EvidenceOutcomeFeedback[];
};
