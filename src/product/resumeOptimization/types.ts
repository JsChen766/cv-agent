export const RESUME_OPTIMIZATION_STAGES = [
  "intake",
  "jd_analysis",
  "evidence_pack",
  "rewrite_plan",
  "draft_generation",
  "layout_check",
  "critic_review",
  "change_set_ready",
  "accepted",
  "exported",
  "failed",
  "needs_input",
] as const;

export type ResumeOptimizationStage = typeof RESUME_OPTIMIZATION_STAGES[number];

export type ResumeOptimizationStageStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "needs_input";

export type ResumeOptimizationRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "needs_input";

export type ResumeOptimizationNextAction = {
  type: string;
  label: string;
  payload?: Record<string, unknown>;
};

export type ResumeOptimizationStageState = {
  stage: ResumeOptimizationStage;
  status: ResumeOptimizationStageStatus;
  label: string;
  message?: string;
  startedAt?: string;
  completedAt?: string;
  artifactIds?: Record<string, string | string[] | undefined>;
  failureReason?: string;
  nextAction?: ResumeOptimizationNextAction;
};

export type ResumeOptimizationWorkflowEvent = {
  id: string;
  runId: string;
  stage: ResumeOptimizationStage;
  status: ResumeOptimizationStageStatus;
  message: string;
  createdAt: string;
  nextAction?: ResumeOptimizationNextAction;
  artifactIds?: Record<string, string | string[] | undefined>;
};

export type ResumeOptimizationRun = {
  schemaVersion: 1;
  runId: string;
  userId: string;
  sessionId?: string;
  generationId?: string;
  jdId?: string;
  jobId?: string;
  status: ResumeOptimizationRunStatus;
  currentStage: ResumeOptimizationStage;
  stages: ResumeOptimizationStageState[];
  events: ResumeOptimizationWorkflowEvent[];
  createdAt: string;
  updatedAt: string;
  failureReason?: string;
  nextAction?: ResumeOptimizationNextAction;
};

export type ResumeOptimizationRunInput = {
  userId: string;
  sessionId?: string;
  jdId?: string;
  jdText?: string;
  targetRole?: string;
  jobId?: string;
};

export type ResumeOptimizationRubricDimension =
  | "ats_keyword_coverage"
  | "jd_alignment"
  | "evidence_strength"
  | "metric_quantification_quality"
  | "star_closure"
  | "professional_expression_quality"
  | "structure_completeness"
  | "layout_risk"
  | "fabrication_exaggeration_risk"
  | "application_readiness";

export type ResumeOptimizationScoreBand = "strong" | "partial" | "weak";
export type ResumeOptimizationFindingSeverity = "low" | "medium" | "high" | "critical";

export type ResumeOptimizationTarget = {
  requirementId?: string;
  sourceExperienceId?: string;
  sectionId?: string;
  itemId?: string;
  bulletId?: string;
  path?: string;
};

export type ResumeOptimizationReportFinding = {
  id: string;
  dimension: ResumeOptimizationRubricDimension;
  severity: ResumeOptimizationFindingSeverity;
  message: string;
  target?: ResumeOptimizationTarget;
  requirementIds: string[];
  sourceExperienceIds: string[];
  evidenceIds: string[];
  recommendedAction: "emphasize" | "rewrite" | "ask_user" | "omit" | "verify" | "layout_review";
};

export type ResumeOptimizationDimensionScore = {
  dimension: ResumeOptimizationRubricDimension;
  score: number;
  band: ResumeOptimizationScoreBand;
  findingIds: string[];
};

export type ATSKeywordCoverageItem = {
  keyword: string;
  requirementIds: string[];
  matched: boolean;
  matchedSourceExperienceIds: string[];
  evidenceIds: string[];
};

export type ATSKeywordCoverageReport = {
  totalKeywords: number;
  matchedKeywords: number;
  missingKeywords: number;
  coverageRatio: number;
  items: ATSKeywordCoverageItem[];
};

export type JDResumeRequirementAnalysis = {
  requirementId: string;
  text: string;
  category: string;
  importance: string;
  evidenceCoverage: "covered" | "partially_covered" | "no_evidence";
  recommendedAction: "use" | "ask_user" | "ignore" | "alternative_angle";
  score: number;
  keywordHits: string[];
  evidenceIds: string[];
  sourceExperienceIds: string[];
  target?: ResumeOptimizationTarget;
};

export type JDResumeAnalysisReport = {
  schemaVersion: 1;
  reportVersion: "resume-optimization-analysis-v1";
  rubricVersion: "resume-optimization-rubric-v1";
  jdId: string;
  targetRole?: string;
  generatedAt: string;
  summary: {
    overallScore: number;
    readiness: ResumeOptimizationScoreBand;
    strongDimensions: ResumeOptimizationRubricDimension[];
    weakDimensions: ResumeOptimizationRubricDimension[];
    topFindingIds: string[];
  };
  dimensions: ResumeOptimizationDimensionScore[];
  requirements: JDResumeRequirementAnalysis[];
  atsKeywordCoverage: ATSKeywordCoverageReport;
  findings: ResumeOptimizationReportFinding[];
  phase3Inputs: {
    prioritizedRequirementIds: string[];
    evidenceBackedSourceExperienceIds: string[];
    missingRequirementIds: string[];
    riskyEvidenceIds: string[];
    rewriteFocusDimensions: ResumeOptimizationRubricDimension[];
  };
};

export type ResumeChangeType =
  | "replace_bullet"
  | "add_bullet"
  | "remove_bullet"
  | "rewrite_headline"
  | "rewrite_summary"
  | "reorder_section"
  | "add_skill_keyword"
  | "remove_weak_item"
  | "tighten_certificate"
  | "layout_compact";

export type ResumeChangeStatus = "pending" | "accepted" | "rejected";
export type ResumeChangeSetStatus = "pending" | "partially_accepted" | "accepted" | "rejected";
export type ResumeChangeRiskLevel = "low" | "medium" | "high" | "critical";

export type ResumeChangeAction = {
  type: "accept_resume_change" | "reject_resume_change";
  label: string;
  payload: {
    changeSetId: string;
    changeId: string;
  };
};

export type ResumeChange = {
  changeId: string;
  type: ResumeChangeType;
  target: ResumeOptimizationTarget;
  before: string;
  after: string;
  reason: string;
  evidenceIds: string[];
  sourceExperienceId?: string;
  riskLevel: ResumeChangeRiskLevel;
  rubricDimensions: ResumeOptimizationRubricDimension[];
  status: ResumeChangeStatus;
  acceptAction: ResumeChangeAction;
  rejectAction: ResumeChangeAction;
};

export type ResumeChangeSet = {
  schemaVersion: 1;
  changeSetId: string;
  generationId: string;
  variantId: string;
  status: ResumeChangeSetStatus;
  summary: {
    totalChanges: number;
    pendingCount: number;
    acceptedCount: number;
    rejectedCount: number;
    label: string;
  };
  originalDraft: import("../types.js").ResumeDocument;
  currentDraft: import("../types.js").ResumeDocument;
  proposedDraft: import("../types.js").ResumeDocument;
  changes: ResumeChange[];
  createdAt: string;
  updatedAt: string;
};
