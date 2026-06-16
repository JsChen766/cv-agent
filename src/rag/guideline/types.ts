export type GuidelineSourceType = "rule" | "example_resume" | "role_template" | "school_template";
export type ApplicationType = "job" | "internship" | "school" | "research";
export type GuidelineLanguage = "zh" | "en";
export type GuidelineRoleFamily = "ai_ml" | "software" | "data" | "product" | "research" | "consulting" | "finance" | "general";
export type GuidelineRuleKind = "hard_constraint" | "writing_rule" | "section_strategy" | "example_pattern" | "selection_rule";

export type GuidelineChunk = {
  id: string;
  sourceType: GuidelineSourceType;
  roleFamily?: string;
  industry?: string;
  applicationType?: ApplicationType;
  language: GuidelineLanguage;
  title: string;
  content: string;
  tags: string[];
  metadata: Record<string, unknown> & {
    builtIn?: boolean;
    mandatory?: boolean;
    ruleKind?: GuidelineRuleKind;
    priority?: number;
    section?: string;
    provenance?: string;
  };
  createdAt: string;
  updatedAt: string;
};

export type GuidelineRoleAnalysis = {
  roleFamily: GuidelineRoleFamily;
  secondaryRoleFamilies: GuidelineRoleFamily[];
  industry?: string;
  applicationType: ApplicationType;
  language: GuidelineLanguage;
  priorityRequirements: string[];
  keywords: string[];
  targetSeniority: "student" | "intern" | "junior" | "experienced" | "unknown";
  emphasisDimensions: string[];
};

export type GuidelineQueryPlan = {
  roleFamilies: GuidelineRoleFamily[];
  applicationType: ApplicationType;
  language: GuidelineLanguage;
  mandatoryTags: string[];
  preferredTags: string[];
  queryVariants: string[];
  sourceQuotas: Partial<Record<GuidelineSourceType, number>>;
};

export type RetrievedGuideline = {
  guideline: GuidelineChunk;
  score: number;
  matchedTags: string[];
  matchedKeywords: string[];
  reason: string;
  scoreBreakdown?: {
    role: number;
    language: number;
    application: number;
    lexical: number;
    mandatory: number;
    diversity: number;
  };
};

export type InstructionPackQuality = {
  status: "ready" | "needs_review";
  mandatoryConstraintsPresent: boolean;
  sourceTypeCoverage: GuidelineSourceType[];
  roleSpecificGuidelineCount: number;
  duplicateRulesRemoved: number;
  conflictsResolved: string[];
  warnings: string[];
};

export type InstructionPack = {
  version: "guideline-rag-v1.5" | "guideline-rag-v2";
  targetPositioning: string;
  roleFamily?: string;
  industry?: string;
  applicationType?: ApplicationType;
  language: GuidelineLanguage;
  priorityRequirements: string[];
  sectionStrategy: {
    summary?: string;
    experience?: string;
    project?: string;
    skills?: string;
    education?: string;
  };
  sectionBudgets?: Partial<Record<"summary" | "experience" | "project" | "skills" | "education", string>>;
  writingRules: string[];
  negativeConstraints: string[];
  hardConstraints?: string[];
  softPreferences?: string[];
  examplePatterns: Array<{
    pattern: string;
    useCase: string;
    sourceGuidelineId?: string;
  }>;
  retrievalTrace: Array<{
    guidelineId: string;
    title: string;
    sourceType: GuidelineSourceType;
    score: number;
    matchedTags: string[];
    reason: string;
  }>;
  queryPlan?: GuidelineQueryPlan;
  quality?: InstructionPackQuality;
};
