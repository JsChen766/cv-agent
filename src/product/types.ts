export type ProductExperienceCategory = "work" | "internship" | "project" | "education" | "award" | "skill" | "other";
export type ProductExperienceStatus = "active" | "archived" | "deleted";
export type ProductExperienceRevisionSource = "manual" | "import" | "copilot" | "resume_upload";
export type ProductExperienceVariantType = "full" | "medium" | "short" | "jd_tailored" | "custom";
export type ProductExperienceVariantStatus = "active" | "archived";
export type ProductJDRecord = {
  id: string;
  userId: string;
  title: string;
  company?: string;
  targetRole?: string;
  rawText: string;
  requirements?: unknown;
  createdAt: string;
  updatedAt: string;
};

export type ProductExperience = {
  id: string;
  userId: string;
  category: ProductExperienceCategory;
  title: string;
  organization?: string;
  role?: string;
  startDate?: string;
  endDate?: string;
  sourceDocumentId?: string;
  tags: string[];
  status: ProductExperienceStatus;
  currentRevisionId?: string;
  createdAt: string;
  updatedAt: string;
};

export type ProductExperienceRevision = {
  id: string;
  experienceId: string;
  userId: string;
  content: string;
  structured?: Record<string, unknown>;
  source: ProductExperienceRevisionSource;
  createdAt: string;
};

export type ProductExperienceVariant = {
  id: string;
  experienceId: string;
  revisionId: string;
  userId: string;
  variantType: ProductExperienceVariantType;
  language: "zh" | "en";
  targetJdId?: string;
  content: string;
  evidenceIds: string[];
  score?: unknown;
  status: ProductExperienceVariantStatus;
  createdAt: string;
};

export type ProductResumeStatus = "draft" | "ready" | "archived";
export type ProductResume = {
  id: string;
  userId: string;
  title: string;
  targetRole?: string;
  jdId?: string;
  templateId?: string;
  status: ProductResumeStatus;
  createdAt: string;
  updatedAt: string;
};

export type ProductResumeItem = {
  id: string;
  resumeId: string;
  userId: string;
  sourceExperienceId?: string;
  sourceVariantId?: string;
  sourceArtifactId?: string;
  sectionType: "experience" | "education" | "project" | "skill" | "award" | "summary" | "other";
  title: string;
  contentSnapshot: string;
  orderIndex: number;
  hidden: boolean;
  pinned: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ProductGeneratedVariant = {
  id: string;
  userId: string;
  content: string;
  sourceExperienceIds?: string[];
  sourceEvidenceIds?: string[];
  scores?: Record<string, number>;
  createdAt: string;
};

export type ProductGeneration = {
  id: string;
  userId: string;
  sessionId?: string;
  jdId?: string;
  resumeId?: string;
  targetRole?: string;
  inputSnapshot: Record<string, unknown>;
  outputSnapshot?: {
    variants?: ProductGeneratedVariant[];
    [key: string]: unknown;
  };
  selectedVariantIds: string[];
  createdAt: string;
};

export type ProductImportJobStatus = "pending" | "extracting" | "candidates_ready" | "confirmed" | "failed";
export type ProductImportJob = {
  id: string;
  userId: string;
  sourceType: "text" | "pdf";
  status: ProductImportJobStatus;
  rawText?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

export type ProductImportCandidateStatus = "pending" | "accepted" | "rejected" | "merged";
export type ProductImportCandidate = {
  id: string;
  jobId: string;
  userId: string;
  title: string;
  category: ProductExperienceCategory;
  organization?: string;
  role?: string;
  startDate?: string;
  endDate?: string;
  sourceDocumentId?: string;
  content: string;
  structured?: Record<string, unknown>;
  status: ProductImportCandidateStatus;
  createdAt: string;
  updatedAt: string;
};

export type ProductResumeTemplate = {
  id: string;
  name: string;
  description?: string;
  config: Record<string, unknown>;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
};

export type ProductExperienceSummary = Pick<ProductExperience, "id" | "category" | "title" | "organization" | "role" | "startDate" | "endDate" | "sourceDocumentId" | "status" | "currentRevisionId" | "createdAt" | "updatedAt"> & {
  content?: string;
  structured?: Record<string, unknown>;
};
export type ProductJDSummary = Pick<ProductJDRecord, "id" | "title" | "company" | "targetRole" | "createdAt" | "updatedAt">;
export type ProductResumeSummary = Pick<ProductResume, "id" | "title" | "targetRole" | "jdId" | "status" | "createdAt" | "updatedAt">;
export type ProductResumeDetail = ProductResume & { items: ProductResumeItem[] };
export type ProductImportCandidateSummary = Pick<ProductImportCandidate, "id" | "jobId" | "title" | "category" | "organization" | "role" | "startDate" | "endDate" | "sourceDocumentId" | "content" | "structured" | "status" | "createdAt" | "updatedAt">;

export type ExperienceDraft = {
  category: ProductExperienceCategory;
  title: string;
  organization?: string;
  role?: string;
  startDate?: string;
  endDate?: string;
  content: string;
  tags: string[];
  structured: {
    summary?: string;
    highlights: string[];
    metrics: Array<{ name: string; value: string; context?: string }>;
    company?: string;
    department?: string;
    employmentType?: string;
    school?: string;
    major?: string;
    degree?: string;
    gpa?: string;
    courses?: string[];
    honors?: string[];
    projectName?: string;
    projectRole?: string;
    techStack?: string[];
    projectUrl?: string;
    issuer?: string;
    awardDate?: string;
    level?: string;
    skillCategory?: string;
    proficiency?: string;
    evidence?: string[];
    rawText: string;
  };
  confidence: number;
  warnings: string[];
};

export type NormalizedExperiencePreview = {
  id?: string;
  category: ProductExperienceCategory;
  title: string;
  organization?: string;
  role?: string;
  startDate?: string;
  endDate?: string;
  location?: string;
  description?: string;
  highlights: string[];
  skills: string[];
  rawText?: string;
  confidence?: number;
  missingFields?: string[];
};
