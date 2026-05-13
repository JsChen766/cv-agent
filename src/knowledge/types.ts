// ── Experience ────────────────────────────────────────────────

export type Experience = {
  id: string;
  title: string;
  company: string;
  startDate: string;  // ISO date
  endDate: string | null;  // null = current
  description: string;
  highlights: string[];
  skillIds: string[];
  createdAt: string;
  updatedAt: string;
};

// ── Evidence ───────────────────────────────────────────────────

export type EvidenceType = "bullet" | "metric" | "project";

export type Evidence = {
  id: string;
  experienceId: string;
  type: EvidenceType;
  content: string;
  /** Where in the experience this evidence comes from (e.g. "highlight[0]") */
  source: string;
  /** 0–1 confidence score */
  confidence: number;
  createdAt: string;
};

// ── Skill ──────────────────────────────────────────────────────

export type SkillCategory = "technical" | "domain" | "soft";

export type Skill = {
  id: string;
  name: string;
  category: SkillCategory;
  evidenceIds: string[];
};

// ── JD Requirement ─────────────────────────────────────────────

export type JDRequirement = {
  id: string;
  jdId: string;
  description: string;
  requiredSkillIds: string[];
  /** Relative importance of this requirement (0–1) */
  weight: number;
};

// ── Generated Artifact ─────────────────────────────────────────

export type GeneratedArtifact = {
  id: string;
  experienceId: string;
  jdRequirementId: string;
  /** The LLM-generated bullet text */
  bulletText: string;
  /** Match score 0–1 */
  score: number;
  matchedSkillIds: string[];
  matchedEvidenceIds: string[];
  createdAt: string;
};

// ── Evidence Chain ─────────────────────────────────────────────

export type EvidenceChain = {
  artifact: GeneratedArtifact;
  experience: Experience;
  evidences: Evidence[];
  skills: Skill[];
  requirement: JDRequirement;
};

// ── Graph View ─────────────────────────────────────────────────

export type GraphNode = {
  id: string;
  type: "experience" | "evidence" | "skill" | "requirement" | "artifact";
  label: string;
  detail: string;
};

export type GraphEdge = {
  from: string;
  to: string;
  label: string;
};

export type GraphView = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};
