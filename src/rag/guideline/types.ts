export type GuidelineSourceType = "rule" | "example_resume" | "role_template" | "school_template";
export type ApplicationType = "job" | "internship" | "school" | "research";
export type GuidelineLanguage = "zh" | "en";

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
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type GuidelineRoleAnalysis = {
  roleFamily?: string;
  industry?: string;
  applicationType: ApplicationType;
  language: GuidelineLanguage;
  priorityRequirements: string[];
  keywords: string[];
  targetSeniority?: "student" | "intern" | "junior" | "experienced" | "unknown";
};

export type RetrievedGuideline = {
  guideline: GuidelineChunk;
  score: number;
  matchedTags: string[];
  matchedKeywords: string[];
  reason: string;
};

export type InstructionPack = {
  version: "guideline-rag-v1.5";
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
  writingRules: string[];
  negativeConstraints: string[];
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
};
