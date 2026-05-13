export type ExperienceType =
  | "work"
  | "project"
  | "education"
  | "volunteer"
  | "other";

export type TimeRange = {
  startDate: string | null;
  endDate: string | null;
};

export type Star = {
  situation: string;
  task: string;
  action: string;
  result: string;
};

export type Experience = {
  id: string;
  userId: string;
  type: ExperienceType;
  organization: string;
  role: string;
  summary: string;
  timeRange: TimeRange;
  star: Star;
  evidenceIds: string[];
  skillIds: string[];
  confidence: number;
  createdAt: string;
  updatedAt: string;
};

export type EvidenceSourceType =
  | "raw_input"
  | "resume"
  | "interview_note"
  | "portfolio"
  | "manual";

export type EvidenceType = "bullet" | "metric" | "project" | "skill" | "outcome";

export type Evidence = {
  id: string;
  userId: string;
  experienceId: string;
  sourceType: EvidenceSourceType;
  evidenceType: EvidenceType;
  sourceRef: string;
  excerpt: string;
  confidence: number;
  createdAt: string;
};

export type SkillCategory = "technical" | "domain" | "soft";

export type Skill = {
  id: string;
  userId: string;
  name: string;
  category: SkillCategory;
  evidenceIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type JDRequirement = {
  id: string;
  userId: string;
  jdId: string;
  description: string;
  requiredSkillIds: string[];
  weight: number;
  createdAt: string;
};

export type ExperienceVariantType =
  | "resume_bullet"
  | "interview_story"
  | "summary";

export type ExperienceVariantStatus = "draft" | "active" | "archived";

export type ExperienceVariant = {
  id: string;
  userId: string;
  experienceId: string;
  type: ExperienceVariantType;
  content: string;
  targetJDId: string | null;
  targetRole: string | null;
  sourceEvidenceIds: string[];
  matchedSkillIds: string[];
  scores: Record<string, number>;
  status: ExperienceVariantStatus;
  createdAt: string;
  updatedAt: string;
};

export type GeneratedArtifactType =
  | "resume_bullet"
  | "resume_summary"
  | "cover_letter_snippet";

export type GeneratedArtifactStatus = "draft" | "ready" | "needs_review";

export type ArtifactScores = {
  overall: number;
  requirementMatch: number;
  evidenceStrength: number;
};

export type GeneratedArtifact = {
  id: string;
  userId: string;
  type: GeneratedArtifactType;
  content: string;
  sourceExperienceIds: string[];
  sourceEvidenceIds: string[];
  matchedSkillIds: string[];
  targetJDId: string;
  targetRequirementIds: string[];
  targetRole: string;
  scores: ArtifactScores;
  status: GeneratedArtifactStatus;
  createdAt: string;
  updatedAt: string;
};

export type EvidenceChainRisk = {
  level: "low" | "medium" | "high";
  reasons: string[];
};

export type EvidenceChain = {
  artifact: GeneratedArtifact;
  experiences: Experience[];
  evidences: Evidence[];
  skills: Skill[];
  requirements: JDRequirement[];
  risk: EvidenceChainRisk;
  scores: ArtifactScores;
};

export type GraphNodeType =
  | "artifact"
  | "experience"
  | "evidence"
  | "skill"
  | "requirement";

export type GraphNode = {
  id: string;
  type: GraphNodeType;
  label: string;
  detail: string;
  score?: number;
  metadata?: Record<string, unknown>;
};

export type GraphEdgeType =
  | "generated_from"
  | "supported_by"
  | "demonstrates"
  | "targets"
  | "requires"
  | "contains";

export type GraphEdge = {
  source: string;
  target: string;
  type: GraphEdgeType;
  label: string;
  weight?: number;
  metadata?: Record<string, unknown>;
};

export type GraphView = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};
