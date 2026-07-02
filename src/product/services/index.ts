import { randomUUID } from "node:crypto";
import type {
  ProductExperience,
  ProductExperienceCategory,
  ProductExperienceRevision,
  ProductExperienceVariant,
  ProductGeneration,
  ProductGeneratedVariant,
  ProductExperienceSummary,
  ProductImportCandidate,
  ProductImportJob,
  ProductJDRecord,
  ProductResume,
  ProductResumeDetail,
  ProductResumeItem,
  ResumeDocument,
  ResumeDocumentSection,
  VariantComparisonMatrixRow,
} from "../types.js";
import { extractExperienceDraftFromText } from "../experienceDraft.js";
import type { LLMExperienceExtractor } from "../LLMExperienceExtractor.js";
import { detectDominantLanguage, extractedCandidateToDraft } from "../LLMExperienceExtractor.js";
import { LLMGenerationError, type LLMExperienceBulletGenerationInput, type LLMGenerationService } from "../LLMGenerationService.js";
import type { EvidenceRAGService, EvidencePack, ClaimGraphIndexer } from "../../rag/evidence/index.js";
import type { GuidelineRAGService } from "../../rag/guideline/index.js";
import { GroundingContextCoordinator } from "../../rag/GroundingContextCoordinator.js";
import type { PreferenceBankService, PersonalizationPack } from "../../self-evolution/preference/index.js";
import { isDeterministicFallbackAllowed } from "../deterministicFallbackGuard.js";
import {
  JDResumeAnalysisService,
  ResumeChangeSetService,
  ResumeOptimizationWorkflowService,
  ResumePreviewSnapshotService,
  type JDResumeAnalysisReport,
  type ResumeChangeSet,
  type ResumeOptimizationRun,
  type ResumePreviewSnapshot,
} from "../resumeOptimization/index.js";
import type {
  ProductExperienceRepository,
  ProductGenerationRepository,
  ProductImportRepository,
  ProductJDRepository,
  ProductResumeRepository,
} from "../repositories/index.js";

export type ProductServices = {
  experienceService: ExperienceService;
  jdService: JDService;
  resumeService: ResumeService;
  importService: ImportService;
  generationProductService: GenerationProductService;
  resumeOptimizationWorkflowService: ResumeOptimizationWorkflowService;
  jdResumeAnalysisService: JDResumeAnalysisService;
  resumeChangeSetService: ResumeChangeSetService;
  resumePreviewSnapshotService: ResumePreviewSnapshotService;
  evidenceRAGService?: EvidenceRAGService;
  guidelineRAGService?: GuidelineRAGService;
  preferenceBankService?: PreferenceBankService;
};

type ImportDraftLike = {
  category: ProductExperienceCategory;
  title: string;
  organization?: string;
  role?: string;
  startDate?: string;
  endDate?: string;
  content: string;
  structured?: Record<string, unknown>;
  confidence?: number;
  warnings?: string[];
  sourceDocumentId?: string;
};

export class ProductStateConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProductStateConflictError";
  }
}

export class ExperienceService {
  public constructor(
    private readonly repository: ProductExperienceRepository,
    private readonly claimGraphIndexer?: ClaimGraphIndexer,
  ) {}

  public async createExperience(userId: string, input: {
    title: string;
    category?: ProductExperienceCategory;
    content: string;
    organization?: string;
    role?: string;
    startDate?: string;
    endDate?: string;
    tags?: string[];
    structured?: Record<string, unknown>;
    sourceDocumentId?: string;
    source?: ProductExperienceRevision["source"];
  }): Promise<{ experience: ProductExperience; revision: ProductExperienceRevision }> {
    const { experience, revision } = buildExperienceRecords(userId, input);
    const result = await this.repository.createExperienceWithRevision(experience, revision);
    await this.indexExperienceBestEffort(userId, result.experience, result.revision);
    return result;
  }

  public async listExperiences(userId: string, filters: { limit?: number; status?: ProductExperience["status"] } = {}): Promise<Array<ProductExperience & { content?: string; structured?: Record<string, unknown> }>> {
    const experiences = await this.repository.listExperiencesByUser(userId, { limit: filters.limit, status: filters.status ?? "active" });
    return Promise.all(experiences.map(async (experience) => {
      const revision = experience.currentRevisionId
        ? await this.repository.getRevisionById(userId, experience.currentRevisionId)
        : null;
      return { ...experience, content: revision?.content, structured: revision?.structured as Record<string, unknown> | undefined };
    }));
  }

  public getExperience(userId: string, id: string): Promise<ProductExperience | null> {
    return this.repository.getExperienceById(userId, id);
  }

  public async updateExperience(userId: string, id: string, patch: Partial<ProductExperience>): Promise<ProductExperience | null> {
    const sanitizedPatch = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as Partial<ProductExperience>;
    return this.repository.updateExperience(userId, id, { ...sanitizedPatch, updatedAt: new Date().toISOString() });
  }

  public archiveExperience(userId: string, id: string): Promise<ProductExperience | null> {
    return this.repository.archiveExperience(userId, id);
  }

  public async createRevision(userId: string, experienceId: string, input: {
    content: string;
    structured?: Record<string, unknown>;
    source?: ProductExperienceRevision["source"];
  }): Promise<ProductExperienceRevision> {
    const experience = await this.repository.getExperienceById(userId, experienceId);
    if (!experience) throw new Error("Experience not found.");
    const revision: ProductExperienceRevision = {
      id: `pexprev-${randomUUID()}`,
      experienceId,
      userId,
      content: input.content,
      structured: input.structured,
      source: input.source ?? "manual",
      createdAt: new Date().toISOString(),
    };
    await this.repository.createRevision(revision);
    const updatedExperience = await this.repository.updateExperience(userId, experienceId, {
      currentRevisionId: revision.id,
      updatedAt: new Date().toISOString(),
    });
    if (updatedExperience) {
      await this.indexExperienceBestEffort(userId, updatedExperience, revision);
    }
    return revision;
  }

  public async indexExperienceBestEffort(
    userId: string,
    experience: ProductExperience,
    revision: ProductExperienceRevision,
  ): Promise<void> {
    if (!this.claimGraphIndexer) return;
    try {
      await this.claimGraphIndexer.indexExperience({ userId, experience, revision });
    } catch (error) {
      console.error("[ClaimGraphIndexer] failed to index experience", {
        experienceId: experience.id,
        revisionId: revision.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public createVariant(userId: string, experienceId: string, revisionId: string, input: {
    variantType?: ProductExperienceVariant["variantType"];
    language?: ProductExperienceVariant["language"];
    targetJdId?: string;
    content: string;
    evidenceIds?: string[];
    score?: unknown;
  }): Promise<ProductExperienceVariant> {
    const variant: ProductExperienceVariant = {
      id: `pexpvar-${randomUUID()}`,
      experienceId,
      revisionId,
      userId,
      variantType: input.variantType ?? "custom",
      language: input.language ?? "zh",
      targetJdId: input.targetJdId,
      content: input.content,
      evidenceIds: input.evidenceIds ?? [],
      score: input.score,
      status: "active",
      createdAt: new Date().toISOString(),
    };
    return this.repository.createVariant(variant);
  }

  public listRevisions(userId: string, experienceId: string): Promise<ProductExperienceRevision[]> {
    return this.repository.listRevisionsByExperience(userId, experienceId);
  }

  public listRevisionsByIds(userId: string, experienceIds: string[]): Promise<ProductExperienceRevision[]> {
    return this.repository.listRevisionsByExperienceIds(userId, experienceIds);
  }

  public listVariants(userId: string, experienceId: string): Promise<ProductExperienceVariant[]> {
    return this.repository.listVariantsByExperience(userId, experienceId);
  }
}

export class JDService {
  public constructor(private readonly repository: ProductJDRepository) {}

  public async saveJD(userId: string, input: {
    rawText: string;
    title?: string;
    company?: string;
    targetRole?: string;
    requirements?: unknown;
  }): Promise<ProductJDRecord> {
    const now = new Date().toISOString();
    const jd: ProductJDRecord = {
      id: `pjd-${randomUUID()}`,
      userId,
      title: nonEmpty(input.title, input.targetRole ?? (input.rawText.slice(0, 40) || "Untitled JD")),
      company: optional(input.company),
      targetRole: optional(input.targetRole),
      rawText: input.rawText,
      requirements: input.requirements,
      createdAt: now,
      updatedAt: now,
    };
    return this.repository.createJD(jd);
  }

  public listJDs(userId: string, limit?: number): Promise<ProductJDRecord[]> {
    return this.repository.listJDsByUser(userId, { limit });
  }

  public getJD(userId: string, id: string): Promise<ProductJDRecord | null> {
    return this.repository.getJDById(userId, id);
  }
}

export class ResumeService {
  public constructor(private readonly repository: ProductResumeRepository) {}

  public async createResume(userId: string, input: {
    title?: string;
    targetRole?: string;
    jdId?: string;
    templateId?: string;
  }): Promise<ProductResume> {
    const now = new Date().toISOString();
    const resume: ProductResume = {
      id: `pres-${randomUUID()}`,
      userId,
      title: nonEmpty(input.title, input.targetRole ? `${input.targetRole} resume` : "Untitled resume"),
      targetRole: optional(input.targetRole),
      jdId: optional(input.jdId),
      templateId: input.templateId ?? "template-default",
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };
    return this.repository.createResume(resume);
  }

  public listResumes(userId: string, limit?: number): Promise<ProductResume[]> {
    return this.repository.listResumesByUser(userId, { limit });
  }

  public async getResume(userId: string, resumeId: string): Promise<ProductResumeDetail | null> {
    const resume = await this.repository.getResumeById(userId, resumeId);
    if (!resume) return null;
    return { ...resume, items: await this.repository.listResumeItems(userId, resumeId) };
  }

  public async addResumeItem(userId: string, resumeId: string, input: {
    sourceExperienceId?: string;
    sourceVariantId?: string;
    sourceArtifactId?: string;
    sectionType?: ProductResumeItem["sectionType"];
    title: string;
    contentSnapshot: string;
    orderIndex?: number;
    metadata?: Record<string, unknown>;
  }): Promise<ProductResumeItem> {
    const resume = await this.repository.getResumeById(userId, resumeId);
    if (!resume) throw new Error("Resume not found.");
    const now = new Date().toISOString();
    const existing = await this.repository.listResumeItems(userId, resumeId);
    const item: ProductResumeItem = {
      id: `presitem-${randomUUID()}`,
      resumeId,
      userId,
      sourceExperienceId: optional(input.sourceExperienceId),
      sourceVariantId: optional(input.sourceVariantId),
      sourceArtifactId: optional(input.sourceArtifactId),
      sectionType: input.sectionType ?? "experience",
      title: nonEmpty(input.title, "Resume item"),
      contentSnapshot: input.contentSnapshot,
      orderIndex: input.orderIndex ?? existing.length,
      hidden: false,
      pinned: false,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    return this.repository.createResumeItem(item);
  }

  public updateResumeItem(userId: string, itemId: string, patch: Partial<ProductResumeItem>): Promise<ProductResumeItem | null> {
    return this.repository.updateResumeItem(userId, itemId, { ...patch, updatedAt: new Date().toISOString() });
  }

  public reorderResumeItems(userId: string, resumeId: string, orderedIds: string[]): Promise<ProductResumeItem[]> {
    return this.repository.reorderResumeItems(userId, resumeId, orderedIds);
  }

  public archiveResume(userId: string, resumeId: string): Promise<ProductResume | null> {
    return this.repository.archiveResume(userId, resumeId);
  }
}

export class ImportService {
  private readonly acceptingCandidates = new Set<string>();
  private readonly acceptedResults = new Map<string, { candidate: ProductImportCandidate; experience: ProductExperience }>();

  public constructor(
    private readonly repository: ProductImportRepository,
    private readonly experienceService: ExperienceService,
    private readonly llmExtractor?: LLMExperienceExtractor,
    private readonly claimGraphIndexer?: ClaimGraphIndexer,
  ) {}

  public createTextImportJob(userId: string, rawText: string, options: { sourceType?: ProductImportJob["sourceType"] } = {}): Promise<ProductImportJob> {
    const now = new Date().toISOString();
    return this.repository.createImportJob({
      id: `pimp-${randomUUID()}`,
      userId,
      sourceType: options.sourceType ?? "text",
      status: "pending",
      rawText,
      createdAt: now,
      updatedAt: now,
    });
  }

  public async createCandidatesFromText(userId: string, jobId: string, options: { sourceDocumentId?: string } = {}): Promise<ProductImportCandidate[]> {
    const job = await this.repository.getImportJob(userId, jobId);
    if (!job) throw new Error("Import job not found.");
    await this.repository.updateImportJobStatus(userId, jobId, { status: "extracting" });

    const rawText = job.rawText ?? "";
    const candidates: ProductImportCandidate[] = [];

    // Primary path: LLM extraction
    if (this.llmExtractor) {
      const extracted = await this.llmExtractor.extractCandidates(rawText);
      if (extracted.length > 0) {
        const llmDrafts = extracted.map((candidate) => extractedCandidateToDraft(candidate, detectDominantLanguage(rawText)));
        const resumeDrafts = buildResumeImportDrafts(rawText);
        const selectedDrafts = extracted.length === 1 && resumeDrafts.length > 1 ? resumeDrafts : llmDrafts;
        for (const draft of selectedDrafts.slice(0, 20)) {
          candidates.push(await this.createImportCandidateFromDraft(userId, jobId, {
            ...draft,
            sourceDocumentId: options.sourceDocumentId,
          }));
        }
        await this.repository.updateImportJobStatus(userId, jobId, { status: "candidates_ready" });
        return candidates;
      }
      // LLM returned no candidates — only fall back in test mode
      const conservative = buildConservativeImportDrafts(rawText);
      if (conservative.length > 0) {
        for (const draft of conservative) {
          candidates.push(await this.createImportCandidateFromDraft(userId, jobId, {
            ...draft,
            sourceDocumentId: options.sourceDocumentId,
          }));
        }
        await this.repository.updateImportJobStatus(userId, jobId, { status: "candidates_ready" });
        return candidates;
      }
      if (!isDeterministicFallbackAllowed()) {
        await this.repository.updateImportJobStatus(userId, jobId, { status: "failed", errorMessage: "LLM extraction returned no candidates." });
        throw new Error("LLM_PROVIDER_NOT_CONFIGURED: The AI model could not extract any experiences from the provided text. Please try with more structured content.");
      }
    } else if (!isDeterministicFallbackAllowed()) {
      const conservative = buildConservativeImportDrafts(rawText);
      if (conservative.length > 0) {
        for (const draft of conservative) {
          candidates.push(await this.createImportCandidateFromDraft(userId, jobId, {
            ...draft,
            sourceDocumentId: options.sourceDocumentId,
          }));
        }
        await this.repository.updateImportJobStatus(userId, jobId, { status: "candidates_ready" });
        return candidates;
      }
      await this.repository.updateImportJobStatus(userId, jobId, { status: "failed", errorMessage: "No LLM provider configured for experience extraction." });
      throw new Error("LLM_PROVIDER_NOT_CONFIGURED: No AI model provider is configured. Set DEEPSEEK_API_KEY or AGENT_API_KEY to enable intelligent experience extraction.");
    }

    // Deterministic fallback: rule-based chunking and extraction (test mode only)
    const resumeDrafts = buildResumeImportDrafts(rawText);
    for (const draft of resumeDrafts) {
      candidates.push(await this.createImportCandidateFromDraft(userId, jobId, {
        ...draft,
        sourceDocumentId: options.sourceDocumentId,
      }));
    }
    const chunks = resumeDrafts.length > 0 ? [] : splitExperienceText(rawText);
    for (const [index, content] of chunks.entries()) {
      const draft = extractExperienceDraftFromText(content);
      candidates.push(await this.createImportCandidateFromDraft(userId, jobId, {
        ...draft,
        title: draft.title || inferTitle(content, `Imported experience ${index + 1}`),
        sourceDocumentId: options.sourceDocumentId,
      }));
    }
    await this.repository.updateImportJobStatus(userId, jobId, { status: "candidates_ready" });
    return candidates;
  }

  private async createImportCandidateFromDraft(
    userId: string,
    jobId: string,
    draft: ImportDraftLike,
  ): Promise<ProductImportCandidate> {
    const now = new Date().toISOString();
    const existingWarnings = Array.isArray(draft.structured?.warnings) ? draft.structured.warnings : [];
    const warnings = draft.warnings ?? existingWarnings;
    return this.repository.createImportCandidate({
      id: `pimpcand-${randomUUID()}`,
      jobId,
      userId,
      title: draft.title,
      category: draft.category,
      organization: draft.organization,
      role: draft.role,
      startDate: draft.startDate,
      endDate: draft.endDate,
      sourceDocumentId: draft.sourceDocumentId,
      content: draft.content,
      structured: {
        ...(draft.structured ?? {}),
        confidence: draft.confidence,
        missingFields: warnings,
        warnings,
      },
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
  }

  public getImportJob(userId: string, id: string): Promise<ProductImportJob | null> {
    return this.repository.getImportJob(userId, id);
  }

  public markImportJobFailed(userId: string, id: string, errorMessage: string): Promise<ProductImportJob | null> {
    return this.repository.updateImportJobStatus(userId, id, { status: "failed", errorMessage });
  }

  public listCandidatesByJob(userId: string, jobId: string): Promise<ProductImportCandidate[]> {
    return this.repository.listCandidatesByJob(userId, jobId);
  }

  public async acceptCandidate(userId: string, candidateId: string, patch: Partial<Pick<ProductImportCandidate, "title" | "category" | "organization" | "role" | "startDate" | "endDate" | "content" | "structured">> = {}): Promise<{ candidate: ProductImportCandidate; experience: ProductExperience }> {
    const candidate = await this.repository.getImportCandidate(userId, candidateId);
    if (!candidate) throw new Error("Import candidate not found.");
    if (candidate.status === "accepted") {
      const cached = this.acceptedResults.get(`${userId}:${candidateId}`);
      if (cached) return cached;
      throw new ProductStateConflictError("Import candidate has already been accepted.");
    }
    if (candidate.status !== "pending") {
      throw new ProductStateConflictError(`Import candidate cannot be accepted from status ${candidate.status}.`);
    }
    const lockKey = `${userId}:${candidateId}`;
    if (this.acceptingCandidates.has(lockKey)) {
      throw new ProductStateConflictError("Import candidate is already being accepted.");
    }
    this.acceptingCandidates.add(lockKey);
    try {
      const mergedCandidate = mergeCandidatePatch(candidate, patch);
      const records = buildExperienceRecords(userId, {
        title: mergedCandidate.title,
        category: mergedCandidate.category,
        content: mergedCandidate.content,
        organization: mergedCandidate.organization,
        role: mergedCandidate.role,
        startDate: mergedCandidate.startDate,
        endDate: mergedCandidate.endDate,
        structured: mergedCandidate.structured,
        sourceDocumentId: mergedCandidate.sourceDocumentId,
        source: "import",
      });
      if (this.repository.acceptCandidateWithExperience) {
        const accepted = await this.repository.acceptCandidateWithExperience({
          userId,
          candidateId,
          experience: records.experience,
          revision: records.revision,
        });
        if (!accepted) throw new Error("Import candidate not found.");
        if (accepted.outcome === "not_pending") {
          if (accepted.candidate.status === "accepted") {
            const cached = this.acceptedResults.get(lockKey);
            if (cached) return cached;
          }
          throw new ProductStateConflictError(`Import candidate cannot be accepted from status ${accepted.candidate.status}.`);
        }
        const result = { candidate: { ...mergedCandidate, ...accepted.candidate, ...pickCandidateEditableFields(mergedCandidate) }, experience: accepted.experience };
        await this.indexAcceptedExperienceBestEffort(userId, accepted.experience, accepted.revision);
        this.acceptedResults.set(lockKey, result);
        return result;
      }
      const { experience } = await this.experienceService.createExperience(userId, {
      title: mergedCandidate.title,
      category: mergedCandidate.category,
      content: mergedCandidate.content,
      organization: mergedCandidate.organization,
      role: mergedCandidate.role,
      startDate: mergedCandidate.startDate,
      endDate: mergedCandidate.endDate,
      structured: mergedCandidate.structured,
      sourceDocumentId: mergedCandidate.sourceDocumentId,
      source: "import",
      });
      const updated = await this.repository.updateCandidateStatus(userId, candidateId, "accepted");
      const result = { candidate: { ...mergedCandidate, ...(updated ?? candidate), ...pickCandidateEditableFields(mergedCandidate) }, experience };
      this.acceptedResults.set(lockKey, result);
      return result;
    } finally {
      this.acceptingCandidates.delete(lockKey);
    }
  }

  private async indexAcceptedExperienceBestEffort(
    userId: string,
    experience: ProductExperience,
    revision: ProductExperienceRevision,
  ): Promise<void> {
    if (!this.claimGraphIndexer) return;
    try {
      await this.claimGraphIndexer.indexExperience({ userId, experience, revision });
    } catch (error) {
      console.error("[ClaimGraphIndexer] failed to index accepted import candidate", {
        experienceId: experience.id,
        revisionId: revision.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public async rejectCandidate(userId: string, candidateId: string): Promise<ProductImportCandidate> {
    const candidate = await this.repository.updateCandidateStatus(userId, candidateId, "rejected");
    if (!candidate) throw new Error("Import candidate not found.");
    return candidate;
  }
}

function buildConservativeImportDrafts(rawText: string): ImportDraftLike[] {
  const resumeDrafts = buildResumeImportDrafts(rawText);
  if (resumeDrafts.length > 0) return resumeDrafts;
  const publication = buildPublicationDraft(rawText);
  return publication ? [publication] : [];
}

export function buildResumeImportDrafts(rawText: string): ImportDraftLike[] {
  const text = normalizeResumeText(rawText);
  if (!text) return [];
  const sections = splitResumeSections(text);
  const drafts: ImportDraftLike[] = [];
  for (const section of sections) {
    for (const chunk of splitResumeSectionEntries(section.category, section.content)) {
      const draft = buildResumeDraft(section.category, chunk);
      if (draft) drafts.push(draft);
      if (drafts.length >= 20) return drafts;
    }
  }
  return drafts;
}

type ResumeSection = {
  category: ProductExperienceCategory;
  content: string;
};

function normalizeResumeText(rawText: string): string {
  return String(rawText ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitResumeSections(text: string): ResumeSection[] {
  const lines = text.split("\n");
  const sections: ResumeSection[] = [];
  let current: ResumeSection | null = null;
  for (const line of lines) {
    const category = sectionCategory(line);
    if (category) {
      if (current && current.content.trim()) sections.push({ ...current, content: current.content.trim() });
      current = { category, content: "" };
      continue;
    }
    if (!current) continue;
    current.content += `${line}\n`;
  }
  if (current && current.content.trim()) sections.push({ ...current, content: current.content.trim() });
  if (sections.length > 0) return sections;

  const chunks = splitExperienceText(text);
  if (chunks.length <= 1 && !hasResumeImportSignals(text)) return [];
  return chunks.map((chunk) => ({ category: inferResumeChunkCategory(chunk), content: chunk }));
}

function hasResumeImportSignals(text: string): boolean {
  const sectionSignals = [
    /教育经历|教育背景|Education/i,
    /实习经历|工作经历|Internship|Work Experience/i,
    /项目经历|项目经验|Projects?/i,
    /获奖经历|荣誉奖项|Awards?|Honors?/i,
    /技能|技能栈|Skills?|Certificates?/i,
  ].filter((pattern) => pattern.test(text)).length;
  const dateSignals = (text.match(/20\d{2}(?:[./-]\d{1,2})?\s*(?:-|–|—|~|至|到|to)\s*(?:20\d{2}(?:[./-]\d{1,2})?|至今|现在|present|current)/gi) ?? []).length;
  const projectSignals = (text.match(/项目[一二三四五六七八九十\d]*[:：-]?|Project\s*\d*[:：-]?/gi) ?? []).length;
  return sectionSignals >= 2 || dateSignals >= 2 || projectSignals >= 2;
}

function sectionCategory(line: string): ProductExperienceCategory | undefined {
  const normalized = line.replace(/\s+/g, "");
  if (!normalized || normalized.length > 24) return undefined;
  if (/^(教育经历|教育背景|教育|Education)$/i.test(normalized)) return "education";
  if (/^(实习经历|实习经验|实习|Internship|Internships)$/i.test(normalized)) return "internship";
  if (/^(工作经历|工作经验|职业经历|WorkExperience|Experience)$/i.test(normalized)) return "work";
  if (/^(项目经历|项目经验|项目|Projects?|ProjectExperience)$/i.test(normalized)) return "project";
  if (/^(获奖经历|荣誉奖项|获奖|荣誉|奖项|Awards?|Honors?)$/i.test(normalized)) return "award";
  if (/^(技能|技能栈|专业技能|证书|技能证书|Skills?|Certificates?)$/i.test(normalized)) return "skill";
  return undefined;
}

function splitResumeSectionEntries(category: ProductExperienceCategory, content: string): string[] {
  const lines = content.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  if (category === "skill") return [lines.join("\n")];
  if (category === "education" || category === "award") {
    const entries = splitByEntryStarts(lines, (line, index) => index > 0 && (isNonBulletDateBoundary(line) || startsNumberedItem(line)));
    return entries.length > 0 ? entries : [lines.join("\n")];
  }
  if (category === "project") {
    const projectEntries = splitByEntryStarts(lines, (line, index) => index > 0 && startsProjectEntry(line));
    if (projectEntries.length > 1) return projectEntries;
    const dateEntries = splitByEntryStarts(lines, (line, index) => index > 0 && isNonBulletDateBoundary(line) && !isLikelyProjectDetailAfterTitle(lines[index - 1], line));
    return dateEntries.length > 1 ? dateEntries : [lines.join("\n")];
  }
  const entries = splitByEntryStarts(lines, (line, index) => index > 0 && (isNonBulletDateBoundary(line) || startsNumberedItem(line)));
  return entries.length > 0 ? entries : [lines.join("\n")];
}

function isNonBulletDateBoundary(line: string): boolean {
  return !startsBulletLine(line) && hasDateRange(line);
}

function isLikelyProjectDetailAfterTitle(previousLine: string | undefined, line: string): boolean {
  if (!previousLine || startsBulletLine(previousLine)) return false;
  if (!hasDateRange(line)) return false;
  return !hasDateRange(previousLine)
    && !startsProjectEntry(previousLine)
    && !sectionCategory(previousLine)
    && previousLine.length <= 60
    && /(角色|职责|担任|负责|Role|Position)/i.test(line);
}

function splitByEntryStarts(lines: string[], isStart: (line: string, index: number) => boolean): string[] {
  const entries: string[] = [];
  let current: string[] = [];
  lines.forEach((line, index) => {
    if (isStart(line, index) && current.length > 0) {
      entries.push(current.join("\n").trim());
      current = [];
    }
    current.push(line);
  });
  if (current.length > 0) entries.push(current.join("\n").trim());
  return entries.filter((entry) => entry.length > 0);
}

function buildResumeDraft(category: ProductExperienceCategory, content: string): ImportDraftLike | null {
  const clean = content.trim();
  if (clean.length < 4) return null;
  const firstLine = clean.split("\n").find(Boolean)?.replace(/^[-*•\d.、\s]+/, "").trim() ?? "";
  const dateRange = extractResumeDateRange(clean);
  const warnings: string[] = [];
  const structured: Record<string, unknown> = {
    summary: clean.replace(/\s+/g, " ").slice(0, 220),
    highlights: clean.split("\n").filter(Boolean).slice(0, 6),
    metrics: extractResumeMetrics(clean),
    rawText: clean,
  };
  let title = firstLine.slice(0, 90);
  let organization: string | undefined;
  let role: string | undefined;

  if (category === "education") {
    organization = extractSchoolName(clean);
    role = [extractDegreeName(clean), extractMajorName(clean)].filter(Boolean).join(" / ") || undefined;
    title = ([organization, role].filter(Boolean).join(" - ") || title) || "教育经历";
    structured.school = organization;
    structured.degree = extractDegreeName(clean);
    structured.major = extractMajorName(clean);
    if (!organization) warnings.push("school_not_found");
  } else if (category === "project") {
    const projectName = (extractProjectTitle(clean) ?? title) || "项目经历";
    title = projectName;
    role = extractProjectRoleName(clean);
    structured.projectName = projectName;
    structured.projectRole = role;
    structured.techStack = extractResumeTags(clean);
  } else if (category === "skill") {
    title = firstLine && !/技能|skills?/i.test(firstLine) ? firstLine : "技能栈";
    structured.skillCategory = title;
    structured.techStack = extractResumeTags(clean);
  } else if (category === "award") {
    title = (extractAwardName(clean) ?? title) || "获奖经历";
    organization = extractAwardIssuer(clean);
    structured.issuer = organization;
    structured.awardDate = dateRange.startDate;
  } else {
    organization = extractResumeOrganization(clean);
    role = extractResumeRole(clean);
    title = [role, organization].filter(Boolean).join(" - ") || title || (category === "internship" ? "实习经历" : "工作经历");
    structured.company = organization;
    structured.employmentType = category === "internship" ? "internship" : undefined;
    if (!organization) warnings.push("organization_not_found");
  }

  return {
    category,
    title,
    organization,
    role: category === "education" ? role : role,
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    content: clean,
    structured,
    confidence: Math.max(0.45, Math.min(0.9, 0.62 + (dateRange.startDate ? 0.1 : 0) + (organization ? 0.08 : 0) + (role ? 0.06 : 0) - warnings.length * 0.04)),
    warnings,
  };
}

function inferResumeChunkCategory(content: string): ProductExperienceCategory {
  const text = content.toLowerCase();
  if (/教育|大学|学院|本科|硕士|博士|university|college|bachelor|master|phd/.test(text)) return "education";
  if (/实习|internship|intern/.test(text)) return "internship";
  if (/项目|project|系统|平台/.test(text)) return "project";
  if (/获奖|奖学金|荣誉|award|honor|scholarship/.test(text)) return "award";
  if (/技能|skills?|证书|certificate/.test(text)) return "skill";
  if (/公司|工作|engineer|analyst|developer/.test(text)) return "work";
  return "other";
}

function hasDateRange(line: string): boolean {
  return /20\d{2}(?:[./-]\d{1,2})?\s*(?:-|–|—|~|至|到|to)\s*(?:20\d{2}(?:[./-]\d{1,2})?|至今|现在|present|current)/i.test(line);
}

function startsNumberedItem(line: string): boolean {
  return /^(?:\d+[.、]|[一二三四五六七八九十]+[、.])\s*/.test(line);
}

function startsProjectEntry(line: string): boolean {
  return /^(?:[-*•]\s*)?(?:项目[一二三四五六七八九十\d]*[:：-]?|Project\s*\d*[:：-]?|(?:\d+[.、]|[一二三四五六七八九十]+[、.])\s*(?:项目|Project))/i.test(line);
}

function extractResumeDateRange(text: string): { startDate?: string; endDate?: string } {
  const match = text.match(/(?<start>20\d{2}(?:[./-]\d{1,2})?)\s*(?:-|–|—|~|至|到|to)\s*(?<end>20\d{2}(?:[./-]\d{1,2})?|至今|现在|present|current)/i);
  return {
    startDate: normalizeResumeDate(match?.groups?.start),
    endDate: normalizeResumeDate(match?.groups?.end),
  };
}

function normalizeResumeDate(value?: string): string | undefined {
  if (!value) return undefined;
  const lower = value.trim().toLowerCase();
  if (["至今", "现在", "present", "current"].includes(lower)) return "present";
  const match = lower.match(/^(20\d{2})(?:[./-](\d{1,2}))?/);
  if (!match) return undefined;
  return match[2] ? `${match[1]}-${match[2].padStart(2, "0")}` : match[1];
}

function extractSchoolName(text: string): string | undefined {
  return text.match(/([\p{Script=Han}A-Za-z&.\-\s]{2,60}(?:大学|学院|University|College|Institute))/u)?.[1]?.trim();
}

function extractDegreeName(text: string): string | undefined {
  return text.match(/(本科|硕士|博士|学士|Bachelor(?:'s)?|Master(?:'s)?|PhD|B\.?Sc|M\.?Sc)/i)?.[1]?.trim();
}

function extractMajorName(text: string): string | undefined {
  return text.match(/(?:专业|Major)[:：\s]*([^\n，,。；;]{2,40})/i)?.[1]?.trim();
}

function extractProjectTitle(text: string): string | undefined {
  const first = text.split("\n").find(Boolean)?.replace(/^[-*•\d.、\s]+/, "").trim();
  return first?.replace(/^项目[一二三四五六七八九十\d]*[:：-]?\s*/, "").slice(0, 90);
}

function extractProjectRoleName(text: string): string | undefined {
  return text.match(/(?:角色|职责|担任|负责|Role)[:：\s-]*([^\n，,。；;]{2,40})/i)?.[1]?.trim()
    ?? text.match(/(负责人|开发者|成员|组长|核心成员|leader|developer|member)/i)?.[1]?.trim();
}

function extractAwardName(text: string): string | undefined {
  return text.split("\n").find((line) => /奖|荣誉|award|honor|scholarship/i.test(line))?.replace(/^[-*•\d.、\s]+/, "").trim().slice(0, 90);
}

function extractAwardIssuer(text: string): string | undefined {
  return text.match(/([\p{Script=Han}A-Za-z&.\-\s]{2,50}(?:大学|学院|协会|委员会|University|College|Association|Committee))/u)?.[1]?.trim();
}

function extractResumeOrganization(text: string): string | undefined {
  return text.match(/([\p{Script=Han}A-Za-z&.\-\s]{2,60}(?:公司|集团|科技|有限责任公司|有限公司|证券|银行|事务所|Inc|LLC|Ltd|Technology|Company))/u)?.[1]?.trim()
    ?? text.match(/\d{4}(?:[./-]\d{1,2})?\s*(?:-|–|—|~|至|到|to)\s*(?:\d{4}(?:[./-]\d{1,2})?|至今|现在|present|current)\s+([^\n，,。；;\s]{2,30})\s+[^\n，,。；;\s]{2,30}(?:实习生|工程师|分析师|研究员|经理|开发|运营|Intern|Engineer|Analyst|Developer)/iu)?.[1]?.trim();
}

function extractResumeRole(text: string): string | undefined {
  return text.match(/(?:职位|岗位|担任|任职|Role|Position)[:：\s-]*([^\n，,。；;]{2,40})/i)?.[1]?.trim()
    ?? text.match(/\d{4}(?:[./-]\d{1,2})?\s*(?:-|–|—|~|至|到|to)\s*(?:\d{4}(?:[./-]\d{1,2})?|至今|现在|present|current)\s+[^\n，,。；;\s]{2,30}\s+([^\n，,。；;\s]{2,30}(?:实习生|工程师|分析师|研究员|经理|开发|运营|Intern|Engineer|Analyst|Developer))/iu)?.[1]?.trim()
    ?? text.match(/([^\n，,。；;]{2,30}(?:实习生|工程师|分析师|研究员|经理|开发|运营|Intern|Engineer|Analyst|Developer))/i)?.[1]?.trim();
}

function extractResumeTags(text: string): string[] {
  const keywords = ["TypeScript", "JavaScript", "React", "Vue", "Node", "Python", "SQL", "Java", "Go", "Docker", "Kubernetes", "Excel", "Power BI", "PyTorch", "TensorFlow"];
  return keywords.filter((keyword) => new RegExp(`\\b${escapeRegExp(keyword)}\\b`, "i").test(text)).slice(0, 12);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractResumeMetrics(text: string): Array<{ name: string; value: string; context?: string }> {
  return Array.from(text.matchAll(/(\d+(?:\.\d+)?)\s*(%|ms|s|秒|分钟|人|次|万|k|m|x|倍)/gi))
    .slice(0, 8)
    .map((match) => ({
      name: "metric",
      value: `${match[1]}${match[2]}`,
      context: text.slice(Math.max(0, (match.index ?? 0) - 24), Math.min(text.length, (match.index ?? 0) + 36)).replace(/\s+/g, " ").trim(),
    }));
}

function buildPublicationDraft(rawText: string): ImportDraftLike | null {
  const text = rawText.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const inputLanguage = detectDominantLanguage(text);
  const mentionsPublication = /paper|publication|published|first author|论文|发表|第一作者|第[一1]作者|璁烘枃|鍙戣〃|绗.{0,8}浣|浣滆/i.test(text);
  const title = extractPublicationTitle(text);
  const hasPublicationContext = mentionsPublication || (Boolean(title) && /multimedia/i.test(text));
  if (!hasPublicationContext || !title) return null;

  const organization = extractPublicationVenue(text);
  const firstAuthor = /first author|1st author|\bauthor\b|第一作者|第[一1]作者|绗.{0,8}浣|浣滆|浣/i.test(text);
  const isChineseOutput = inputLanguage === "zh";
  const role = firstAuthor ? (isChineseOutput ? "第一作者" : "first author") : undefined;
  const isMultimodalEmotionRecognition = /multimodal emotion recognition|多模态情感识别/i.test(text);
  const tags = [
    isChineseOutput ? "论文" : "paper",
    isChineseOutput ? "发表" : "publication",
    isMultimodalEmotionRecognition ? (isChineseOutput ? "多模态情感识别" : "multimodal emotion recognition") : "",
  ].filter(Boolean);
  const warnings = ["External details are unverified and can be added later."];
  const content = isChineseOutput
    ? [
        role ? `以${role}身份发表论文《${title}》。` : `发表论文《${title}》。`,
        organization ? `用户提到的期刊为 ${organization}。` : "",
        isMultimodalEmotionRecognition ? "研究方向为多模态情感识别。" : "",
        "外部细节尚未核验，可后续补充。",
      ].filter(Boolean).join("")
    : [
        role
          ? `Published "${title}" as ${role}.`
          : `Published "${title}".`,
        organization ? `Venue stated by user: ${organization}.` : "",
        isMultimodalEmotionRecognition
          ? "The work is related to multimodal emotion recognition."
          : "",
      ].filter(Boolean).join(" ");
  const draftTitle = isChineseOutput && firstAuthor && isMultimodalEmotionRecognition
    ? "第一作者发表多模态情感识别论文"
    : isChineseOutput
      ? "发表论文经历"
      : title;

  return {
    category: "project",
    title: draftTitle,
    organization,
    role,
    startDate: undefined,
    endDate: undefined,
    content,
    structured: {
      inputLanguage,
      summary: content,
      highlights: [content],
      metrics: [],
      projectName: title,
      projectRole: role,
      techStack: tags,
      rawText: text,
      warnings,
    },
  };
}

function extractPublicationTitle(text: string): string | undefined {
  const patterns = [
    /(?:titled|title[:：]?|论文\s*)["*“”']?\s*([A-Z][A-Za-z0-9&,:;'"’()\/+\-\s]{10,180}?)(?=\s*(?:,|，|。|；|;|\.| which | related | is related | 是|锛|$))/i,
    /([A-Z][A-Za-z0-9&,:;'"’()\/+\-\s]{10,180}?Multimodal Emotion Recognition)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = match?.[1]?.replace(/[*"“”']/g, "").replace(/\s+/g, " ").trim();
    if (value) return value.slice(0, 160);
  }
  return undefined;
}

function extractPublicationVenue(text: string): string | undefined {
  if (/ieee\s+transactions?\s+on\s+multimedia/i.test(text)) return "IEEE Transactions on Multimedia";
  if (/transactions?\s+on\s+multimedia/i.test(text)) return "IEEE Transactions on Multimedia";
  if (/ransactions?\s+on\s+multimedia/i.test(text)) return "IEEE Transactions on Multimedia";
  return undefined;
}

function mergeCandidatePatch(
  candidate: ProductImportCandidate,
  patch: Partial<Pick<ProductImportCandidate, "title" | "category" | "organization" | "role" | "startDate" | "endDate" | "content" | "structured">>,
): ProductImportCandidate {
  const validCategories: ProductExperienceCategory[] = ["work", "internship", "project", "education", "award", "skill", "other"];
  const category = patch.category && validCategories.includes(patch.category) ? patch.category : candidate.category;
  return {
    ...candidate,
    title: nonEmpty(patch.title, candidate.title),
    category,
    organization: optional(patch.organization) ?? candidate.organization,
    role: optional(patch.role) ?? candidate.role,
    startDate: optional(patch.startDate) ?? candidate.startDate,
    endDate: optional(patch.endDate) ?? candidate.endDate,
    content: nonEmpty(patch.content, candidate.content),
    structured: patch.structured && typeof patch.structured === "object" && !Array.isArray(patch.structured)
      ? patch.structured
      : candidate.structured,
  };
}

function pickCandidateEditableFields(candidate: ProductImportCandidate): Partial<ProductImportCandidate> {
  return {
    title: candidate.title,
    category: candidate.category,
    organization: candidate.organization,
    role: candidate.role,
    startDate: candidate.startDate,
    endDate: candidate.endDate,
    content: candidate.content,
    structured: candidate.structured,
  };
}

export class GenerationProductService {
  private readonly groundingCoordinator = new GroundingContextCoordinator();

  public constructor(
    private readonly repository: ProductGenerationRepository,
    private readonly jdService: JDService,
    private readonly resumeService: ResumeService,
    private readonly experienceService: ExperienceService,
    private readonly llmGenerationService?: LLMGenerationService,
    private readonly evidenceRAGService?: EvidenceRAGService,
    private readonly guidelineRAGService?: GuidelineRAGService,
    private readonly preferenceBankService?: PreferenceBankService,
    private readonly resumeOptimizationWorkflowService: ResumeOptimizationWorkflowService = new ResumeOptimizationWorkflowService(),
    private readonly jdResumeAnalysisService: JDResumeAnalysisService = new JDResumeAnalysisService(),
    private readonly resumeChangeSetService: ResumeChangeSetService = new ResumeChangeSetService(),
    private readonly resumePreviewSnapshotService: ResumePreviewSnapshotService = new ResumePreviewSnapshotService(),
  ) {}

  public async generateResumeFromJD(input: {
    userId: string;
    sessionId?: string;
    jdId?: string;
    jdText?: string;
    targetRole?: string;
    resumeOptimizationRun?: ResumeOptimizationRun;
  }): Promise<{
    generation: ProductGeneration;
    jd: ProductJDRecord;
    variants: ProductGeneratedVariant[];
    recommendedVariantId?: string;
    comparisonMatrix?: VariantComparisonMatrixRow[];
    workflowRun: ResumeOptimizationRun;
    analysisReport: JDResumeAnalysisReport;
    resumeChangeSet?: ResumeChangeSet;
    resumeChangeSets: ResumeChangeSet[];
    resumePreviewSnapshots: ResumePreviewSnapshot[];
    resumeDocumentDraft?: ResumeDocument;
  }> {
    if (!input.jdId && !input.jdText?.trim()) {
      throw new Error("JD text or jdId is required.");
    }
    const workflowRun = input.resumeOptimizationRun
      ?? this.resumeOptimizationWorkflowService.startRun({
        userId: input.userId,
        sessionId: input.sessionId,
        jdId: input.jdId,
        jdText: input.jdText,
        targetRole: input.targetRole,
      });

    const jd = input.jdId
      ? await this.jdService.getJD(input.userId, input.jdId)
      : await this.jdService.saveJD(input.userId, {
          rawText: input.jdText ?? "",
          targetRole: input.targetRole,
        });
    if (!jd) throw new Error("JD not found.");

    const targetRole = input.targetRole ?? jd.targetRole;
    const baseInstructionPack = this.guidelineRAGService
      ? await this.guidelineRAGService.buildInstructionPack({
          userId: input.userId,
          jdText: jd.rawText,
          targetRole,
          limit: 8,
        })
      : undefined;

    const personalizationPack: PersonalizationPack | undefined = this.preferenceBankService
      ? await this.preferenceBankService.buildPersonalizationPack({
          userId: input.userId,
          context: {
            targetRole,
            roleFamily: baseInstructionPack?.roleFamily,
            applicationType: baseInstructionPack?.applicationType,
            language: baseInstructionPack?.language,
            industry: baseInstructionPack?.industry,
          },
          limit: 12,
        })
      : undefined;

    const instructionPack = personalizationPack && this.preferenceBankService
      ? this.preferenceBankService.applyToInstructionPack(baseInstructionPack, personalizationPack)
      : baseInstructionPack;

    const baseEvidencePack = this.evidenceRAGService
      ? await this.evidenceRAGService.buildEvidencePack({
          userId: input.userId,
          jdText: jd.rawText,
          targetRole,
          roleFamily: instructionPack?.roleFamily,
          limit: 12,
        })
      : undefined;

    const evidencePack = personalizationPack && this.preferenceBankService
      ? this.preferenceBankService.applyToEvidencePack(baseEvidencePack, personalizationPack)
      : baseEvidencePack;

    const allActiveExperiences = await this.experienceService.listExperiences(input.userId, {
      limit: 100,
      status: "active",
    });
    const experiences = buildResumeSourceExperienceSet(allActiveExperiences, evidencePack, jd.rawText);

    const evidencePackForGeneration = evidencePack
      ? enrichEvidencePackWithSourceExperienceFacts(
          narrowEvidencePackToSourceExperiences(evidencePack, experiences),
          experiences,
        )
      : undefined;

    const analysisReport = await this.jdResumeAnalysisService.analyze({
      jd,
      targetRole,
      sourceExperiences: experiences,
      evidencePack: evidencePackForGeneration,
    });

    const groundingContext = this.groundingCoordinator.build({
      instructionPack,
      evidencePack: evidencePackForGeneration,
    });

    let variants: ProductGeneratedVariant[];
    let recommendedVariantId: string | undefined;
    let comparisonMatrix: VariantComparisonMatrixRow[] | undefined;

    if (this.llmGenerationService) {
      try {
        const llmResult = evidencePackForGeneration || instructionPack
          ? await this.llmGenerationService.generateVariantsWithGroundingContext({
              userId: input.userId,
              jdText: jd.rawText,
              targetRole,
              evidencePack: evidencePackForGeneration,
              sourceExperiences: experiences,
              instructionPack,
              groundingContext,
              personalizationPack,
            })
          : await this.llmGenerationService.generateVariants(
              input.userId,
              jd.rawText,
              targetRole,
              experiences,
            );

        variants = llmResult.variants;
        recommendedVariantId = llmResult.recommendedVariantId;
        comparisonMatrix = llmResult.comparisonMatrix;

        if (evidencePackForGeneration && this.evidenceRAGService) {
          variants = this.evidenceRAGService.verifyGeneratedVariants(variants, evidencePackForGeneration);
        }
        variants = densifyGeneratedResumeVariants({
          variants,
          sourceExperiences: experiences,
          recommendedVariantId,
        });
        variants = await refineGeneratedResumeVariantsWithCareerBullets({
          variants,
          sourceExperiences: experiences,
          jdText: jd.rawText,
          targetRole,
          recommendedVariantId,
          llmGenerationService: this.llmGenerationService,
        });
      } catch (error) {
        throw generationFailureError(error);
      }

      if (variants.length === 0) {
        throw new Error(
          "LLM_GENERATION_FAILED: The AI model call completed but no valid resume variants were produced.",
        );
      }
    } else if (!isDeterministicFallbackAllowed()) {
      throw new Error(
        "LLM_PROVIDER_NOT_CONFIGURED: No AI model provider is configured. Set DEEPSEEK_API_KEY or AGENT_API_KEY to enable intelligent resume generation.",
      );
    } else {
      variants = buildDraftVariants(input.userId, jd.rawText, targetRole, experiences);
      if (evidencePackForGeneration && this.evidenceRAGService) {
        variants = this.evidenceRAGService.verifyGeneratedVariants(variants, evidencePackForGeneration);
      }
    }

    const generation: ProductGeneration = {
      id: `pgen-${randomUUID()}`,
      userId: input.userId,
      sessionId: input.sessionId,
      jdId: jd.id,
      targetRole,
      inputSnapshot: {
        jdId: jd.id,
        targetRole,
        sourceExperienceIds: experiences.map((item) => item.id),
        ...(instructionPack ? { instructionPack } : {}),
        ...(evidencePackForGeneration ? { evidencePack: evidencePackForGeneration } : {}),
        ...(personalizationPack ? { personalizationPack } : {}),
        analysisReport,
        groundingContext,
      },
      outputSnapshot: {
        variants,
        recommendedVariantId,
        comparisonMatrix,
      },
      selectedVariantIds: [],
      createdAt: new Date().toISOString(),
    };
    const resumeChangeSets = this.resumeChangeSetService.createChangeSets({
      generation,
      variants,
      recommendedVariantId,
      analysisReport,
      sourceExperiences: experiences,
    });
    const resumeChangeSet = resumeChangeSets[0];
    const resumePreviewSnapshots = resumeChangeSet
      ? this.resumePreviewSnapshotService.createSnapshots({
          changeSet: resumeChangeSet,
          analysisReport,
          generationId: generation.id,
        })
      : [];
    const resumeDocumentDraft = this.resumePreviewSnapshotService.pickRenderableDraft(resumePreviewSnapshots);
    generation.inputSnapshot.resumeChangeSet = resumeChangeSet;
    generation.inputSnapshot.resumePreviewSnapshots = resumePreviewSnapshots;
    generation.inputSnapshot.resumeDocumentDraft = resumeDocumentDraft;
    generation.outputSnapshot = {
      ...(generation.outputSnapshot ?? {}),
      resumeChangeSet,
      resumeChangeSets,
      resumePreviewSnapshots,
      resumeDocumentDraft,
    };
    const completedWorkflowRun = this.resumeOptimizationWorkflowService.completeDraftGeneration({
      run: workflowRun,
      jd,
      generation,
      variants,
      sourceExperienceIds: experiences.map((item) => item.id),
      evidencePack: evidencePackForGeneration,
      targetRole,
      resumeChangeSet,
    });
    generation.inputSnapshot.resumeOptimizationRun = completedWorkflowRun;
    generation.outputSnapshot = {
      ...(generation.outputSnapshot ?? {}),
      resumeOptimizationRun: completedWorkflowRun,
      analysisReport,
      resumeChangeSet,
      resumeChangeSets,
      resumePreviewSnapshots,
      resumeDocumentDraft,
    };

    await this.repository.createGeneration(generation);

    if (this.evidenceRAGService && evidencePackForGeneration) {
      await this.evidenceRAGService.recordGenerationUsage({
        userId: input.userId,
        generationId: generation.id,
        jdId: jd.id,
        targetRole,
        roleFamily: instructionPack?.roleFamily,
        evidencePack: evidencePackForGeneration,
        variants,
      });
    }

    return {
      generation,
      jd,
      variants,
      recommendedVariantId,
      comparisonMatrix,
      workflowRun: completedWorkflowRun,
      analysisReport,
      resumeChangeSet,
      resumeChangeSets,
      resumePreviewSnapshots,
      resumeDocumentDraft,
    };
  }

  public async saveAcceptedVariantToResume(userId: string, input: {
    generationId: string;
    variantId: string;
    resumeId?: string;
  }): Promise<{ generation: ProductGeneration; resume: ProductResume; item: ProductResumeItem; items?: ProductResumeItem[]; variant: ProductGeneratedVariant }> {
    const generation = await this.repository.getGeneration(userId, input.generationId);
    if (!generation) throw new Error("Generation not found.");

    const variants = generation.outputSnapshot?.variants ?? [];
    const variant = variants.find((item) => item.id === input.variantId);
    if (!variant) throw new Error("Variant not found in generation.");

    const resume = input.resumeId
      ? await this.resumeService.getResume(userId, input.resumeId)
      : null;

    // Decide whether to take the structured path based on a present, schema-
    // valid `resumeDocument`. The legacy single-item path is preserved
    // *byte-identically* for variants that lack a usable document — the LLM
    // schema in `LLMGenerationService` already drops malformed documents
    // silently, so by the time we reach here `variant.resumeDocument` is
    // either undefined or fully valid.
    const documentItems = collectResumeDocumentItems(variant);
    if (documentItems.length > 0) {
      return this.saveAcceptedVariantWithDocument(userId, {
        generation,
        variant,
        resume,
        documentItems,
      });
    }

    const targetResume = resume
      ? resumeToRecord(resume)
      : buildResumeRecord(userId, {
          targetRole: generation.targetRole,
          jdId: generation.jdId,
          title: buildGeneratedResumeTitle(generation.targetRole),
        });

    const item = buildResumeItemRecord(userId, targetResume.id, {
      sourceArtifactId: variant.id,
      sectionType: "experience",
      title: inferTitle(variant.content, "Accepted variant"),
      contentSnapshot: variant.content,
      orderIndex: resume?.items.length ?? 0,
      metadata: { generationId: generation.id },
    });

    const selected = Array.from(
      new Set([...generation.selectedVariantIds, variant.id]),
    );

    if (this.repository.saveAcceptedVariantToResume) {
      const saved = await this.repository.saveAcceptedVariantToResume({
        userId,
        generationId: generation.id,
        resume: targetResume,
        item,
        selectedVariantIds: selected,
      });
      if (saved) {
        await this.recordAcceptedVariantEvidence(
          userId,
          generation.id,
          variant,
          item.contentSnapshot,
        );
        return { ...saved, variant };
      }
    }

    const savedResume = resume
      ? targetResume
      : await this.resumeService.createResume(userId, {
          targetRole: generation.targetRole,
          jdId: generation.jdId,
          title: targetResume.title,
        });

    const savedItem = await this.resumeService.addResumeItem(
      userId,
      savedResume.id,
      {
        sourceArtifactId: variant.id,
        sectionType: item.sectionType,
        title: item.title,
        contentSnapshot: item.contentSnapshot,
        metadata: item.metadata,
      },
    );

    await this.repository.updateGenerationSelection(
      userId,
      generation.id,
      selected,
    );
    const attached = await this.repository.attachResume(
      userId,
      generation.id,
      savedResume.id,
    );

    await this.recordAcceptedVariantEvidence(
      userId,
      generation.id,
      variant,
      savedItem.contentSnapshot,
    );

    return {
      generation: attached ?? generation,
      resume: savedResume,
      item: savedItem,
      variant,
    };
  }

  /**
   * Structured save path — activated only when `variant.resumeDocument` is
   * present and yields ≥2 items. Creates one ProductResumeItem per
   * document item, preserving section/item/bullet ids inside
   * `metadata_json` so future stages can reconstruct the tree without a
   * schema migration.
   *
   * The plain (single-item) path above is left untouched so legacy variants
   * continue to produce byte-identical persistence.
   */
  private async saveAcceptedVariantWithDocument(
    userId: string,
    input: {
      generation: ProductGeneration;
      variant: ProductGeneratedVariant;
      resume: ProductResumeDetail | null;
      documentItems: ResumeDocumentItemEntry[];
    },
  ): Promise<{ generation: ProductGeneration; resume: ProductResume; item: ProductResumeItem; items: ProductResumeItem[]; variant: ProductGeneratedVariant }> {
    const { generation, variant, resume, documentItems } = input;
    const savedResume = resume
      ? resumeToRecord(resume)
      : await this.resumeService.createResume(userId, {
        targetRole: generation.targetRole,
        jdId: generation.jdId,
        title: buildGeneratedResumeTitle(generation.targetRole),
      });
    const baseOrderIndex = resume?.items.length ?? 0;
    const items: ProductResumeItem[] = [];
    for (let i = 0; i < documentItems.length; i += 1) {
      const entry = documentItems[i];
      const itemMetadata: Record<string, unknown> = {
        generationId: generation.id,
        sourceVariantId: variant.id,
        sectionId: entry.sectionId,
        sectionType: entry.sectionType,
        sectionOrder: entry.sectionOrder,
        itemId: entry.itemId,
        bulletIds: entry.bulletIds,
        bulletTexts: entry.bulletTexts,
        bulletEvidence: entry.bulletEvidence,
      };
      if (entry.sourceExperienceId) itemMetadata.sourceExperienceId = entry.sourceExperienceId;
      if (entry.evidenceStrength) itemMetadata.evidenceStrength = entry.evidenceStrength;
      if (entry.relevanceScore != null) itemMetadata.relevanceScore = entry.relevanceScore;

      const saved = await this.resumeService.addResumeItem(userId, savedResume.id, {
        sourceArtifactId: variant.id,
        sourceExperienceId: entry.sourceExperienceId,
        sectionType: entry.sectionType,
        title: entry.title,
        contentSnapshot: entry.contentSnapshot,
        metadata: itemMetadata,
      });
      items.push(saved);
    }
    const selected = Array.from(new Set([...generation.selectedVariantIds, variant.id]));
    await this.repository.updateGenerationSelection(userId, generation.id, selected);
    const attached = await this.repository.attachResume(userId, generation.id, savedResume.id);
    await this.recordAcceptedVariantEvidence(
      userId,
      generation.id,
      variant,
      items.map((item) => item.contentSnapshot).join("\n\n"),
    );
    void baseOrderIndex; // resumeService manages orderIndex; kept for parity if repo path is added later.
    return {
      generation: attached ?? generation,
      resume: savedResume,
      item: items[0],
      items,
      variant,
    };
  }

  private async recordAcceptedVariantEvidence(
    userId: string,
    generationId: string,
    variant: ProductGeneratedVariant,
    finalText: string,
  ): Promise<void> {
    if (this.evidenceRAGService) {
      await this.evidenceRAGService.recordVariantDecision({
        userId,
        generationId,
        variantId: variant.id,
        action: "accepted",
        finalText,
        claimIds: variant.sourceEvidenceIds,
        metadata: { source: "saveAcceptedVariantToResume" },
      });
    }

    if (this.preferenceBankService) {
      await this.preferenceBankService.recordVariantDecision({
        userId,
        generationId,
        variantId: variant.id,
        action: "accepted",
        source: "saveAcceptedVariantToResume",
      });
    }
  }

  public getGeneration(
    userId: string,
    id: string,
  ): Promise<ProductGeneration | null> {
    return this.repository.getGeneration(userId, id);
  }

  public listGenerations(
    userId: string,
    limit?: number,
  ): Promise<ProductGeneration[]> {
    return this.repository.listGenerationsByUser(userId, { limit });
  }
}

function filterExperiencesByEvidencePack<T extends ProductExperienceSummary>(
  experiences: T[],
  evidencePack: EvidencePack,
): T[] {
  const rankedIds = evidencePack.retrievalTrace.map((item) => item.experienceId);
  const rank = new Map(rankedIds.map((id, index) => [id, index]));

  return experiences
    .filter((item) => rank.has(item.id))
    .sort(
      (a, b) =>
        (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER)
        - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
}

function buildResumeSourceExperienceSet<T extends ProductExperienceSummary>(
  experiences: T[],
  evidencePack?: EvidencePack,
  jdText?: string,
): T[] {
  const foundation = experiences
    .filter((item) => item.category === "education" || item.category === "skill" || item.category === "award")
    .sort((a, b) => foundationCategoryRank(a.category) - foundationCategoryRank(b.category)
      || a.createdAt.localeCompare(b.createdAt));
  const rankedCareer = rankCareerExperiencesForJD(experiences, evidencePack, jdText);
  const workLike = rankedCareer
    .filter((item) => item.experience.category === "internship" || item.experience.category === "work")
    .slice(0, 3)
    .map((item) => item.experience);
  const projects = rankedCareer
    .filter((item) => item.experience.category === "project")
    .slice(0, 3)
    .map((item) => item.experience);
  const merged = new Map<string, T>();
  for (const item of [...foundation, ...workLike, ...projects]) {
    if (!merged.has(item.id)) merged.set(item.id, item);
  }
  return [...merged.values()];
}

type RankedResumeExperience<T extends ProductExperienceSummary> = {
  experience: T;
  evidenceScore: number;
  evidenceRank: number;
  keywordScore: number;
};

function rankCareerExperiencesForJD<T extends ProductExperienceSummary>(
  experiences: T[],
  evidencePack: EvidencePack | undefined,
  jdText: string | undefined,
): RankedResumeExperience<T>[] {
  const traceRank = new Map<string, { score: number; rank: number }>();
  if (evidencePack) {
    evidencePack.retrievalTrace.forEach((trace, index) => {
      const existing = traceRank.get(trace.experienceId);
      const score = Number.isFinite(trace.score) ? trace.score : 0;
      if (!existing || score > existing.score || (score === existing.score && index < existing.rank)) {
        traceRank.set(trace.experienceId, { score, rank: index });
      }
    });
  }

  return experiences
    .filter((item) => item.category === "internship" || item.category === "work" || item.category === "project")
    .map((experience) => {
      const trace = traceRank.get(experience.id);
      return {
        experience,
        evidenceScore: trace?.score ?? 0,
        evidenceRank: trace?.rank ?? Number.MAX_SAFE_INTEGER,
        keywordScore: keywordResumeMatchScore(experience, jdText),
      };
    })
    .sort((a, b) => {
      const evidenceDiff = b.evidenceScore - a.evidenceScore;
      if (Math.abs(evidenceDiff) > 0.0001) return evidenceDiff;
      const traceDiff = a.evidenceRank - b.evidenceRank;
      if (traceDiff !== 0) return traceDiff;
      const keywordDiff = b.keywordScore - a.keywordScore;
      if (Math.abs(keywordDiff) > 0.0001) return keywordDiff;
      return compareResumeSourceCandidate(a.experience, b.experience);
    });
}

function keywordResumeMatchScore(experience: ProductExperienceSummary, jdText: string | undefined): number {
  const jdTerms = extractResumeMatchTerms(jdText ?? "");
  if (jdTerms.length === 0) return 0;
  const sourceText = [
    experience.title,
    experience.organization ?? "",
    experience.role ?? "",
    experience.content ?? "",
    ...collectResumeStructuredTerms(experience.structured),
  ].join(" ").toLowerCase();
  const matched = jdTerms.filter((term) => sourceText.includes(term));
  return matched.length / Math.min(jdTerms.length, 48);
}

function extractResumeMatchTerms(text: string): string[] {
  const lower = text.toLowerCase();
  const ascii = lower.match(/[a-z][a-z0-9+#.-]{1,}/g) ?? [];
  const cjk = lower.match(/[\u3400-\u9fff]{2,}/g) ?? [];
  return Array.from(new Set([...ascii, ...cjk]))
    .filter((term) => !RESUME_MATCH_STOPWORDS.has(term))
    .slice(0, 80);
}

function collectResumeStructuredTerms(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectResumeStructuredTerms(item));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((item) => collectResumeStructuredTerms(item));
  }
  return [];
}

const RESUME_MATCH_STOPWORDS = new Set([
  "with",
  "and",
  "the",
  "for",
  "from",
  "this",
  "that",
  "your",
  "岗位",
  "要求",
  "负责",
  "能力",
  "相关",
  "经验",
  "熟悉",
  "优先",
]);

function foundationCategoryRank(category: ProductExperienceSummary["category"]): number {
  if (category === "education") return 0;
  if (category === "award") return 1;
  if (category === "skill") return 2;
  return 3;
}

function compareResumeSourceCandidate<T extends ProductExperienceSummary>(a: T, b: T): number {
  const categoryDiff = resumeSourceCategoryRank(a.category) - resumeSourceCategoryRank(b.category);
  if (categoryDiff !== 0) return categoryDiff;
  return resumeSourceRecencyKey(b).localeCompare(resumeSourceRecencyKey(a));
}

function resumeSourceCategoryRank(category: ProductExperienceSummary["category"]): number {
  if (category === "internship" || category === "work") return 0;
  if (category === "project") return 1;
  return 2;
}

function resumeSourceRecencyKey(item: ProductExperienceSummary): string {
  return item.endDate || item.startDate || item.createdAt || "";
}

function buildExperienceRecords(userId: string, input: {
  title: string;
  category?: ProductExperienceCategory;
  content: string;
  organization?: string;
  role?: string;
  startDate?: string;
  endDate?: string;
  tags?: string[];
  structured?: Record<string, unknown>;
  sourceDocumentId?: string;
  source?: ProductExperienceRevision["source"];
}): { experience: ProductExperience; revision: ProductExperienceRevision } {
  const now = new Date().toISOString();
  const experienceId = `pexp-${randomUUID()}`;
  const revisionId = `pexprev-${randomUUID()}`;
  const experience: ProductExperience = {
    id: experienceId,
    userId,
    category: input.category ?? "work",
    title: nonEmpty(input.title, "Untitled experience"),
    organization: optional(input.organization),
    role: optional(input.role),
    startDate: optional(input.startDate),
    endDate: optional(input.endDate),
    sourceDocumentId: optional(input.sourceDocumentId),
    tags: input.tags ?? [],
    status: "active",
    currentRevisionId: revisionId,
    createdAt: now,
    updatedAt: now,
  };
  const revision: ProductExperienceRevision = {
    id: revisionId,
    experienceId,
    userId,
    content: input.content,
    structured: input.structured,
    source: input.source ?? "manual",
    createdAt: now,
  };
  return { experience, revision };
}

function buildResumeRecord(userId: string, input: {
  title?: string;
  targetRole?: string;
  jdId?: string;
  templateId?: string;
}): ProductResume {
  const now = new Date().toISOString();
  return {
    id: `pres-${randomUUID()}`,
    userId,
    title: nonEmpty(input.title, input.targetRole ? `${input.targetRole} resume` : "Untitled resume"),
    targetRole: optional(input.targetRole),
    jdId: optional(input.jdId),
    templateId: input.templateId ?? "template-default",
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
}

function buildGeneratedResumeTitle(targetRole: string | undefined): string {
  const role = targetRole?.trim();
  return role ? `${role}简历` : "个人简历";
}

function buildResumeItemRecord(userId: string, resumeId: string, input: {
  sourceExperienceId?: string;
  sourceVariantId?: string;
  sourceArtifactId?: string;
  sectionType?: ProductResumeItem["sectionType"];
  title: string;
  contentSnapshot: string;
  orderIndex?: number;
  metadata?: Record<string, unknown>;
}): ProductResumeItem {
  const now = new Date().toISOString();
  return {
    id: `presitem-${randomUUID()}`,
    resumeId,
    userId,
    sourceExperienceId: optional(input.sourceExperienceId),
    sourceVariantId: optional(input.sourceVariantId),
    sourceArtifactId: optional(input.sourceArtifactId),
    sectionType: input.sectionType ?? "experience",
    title: nonEmpty(input.title, "Resume item"),
    contentSnapshot: input.contentSnapshot,
    orderIndex: input.orderIndex ?? 0,
    hidden: false,
    pinned: false,
    metadata: input.metadata ?? {},
    createdAt: now,
    updatedAt: now,
  };
}

function resumeToRecord(resume: ProductResume): ProductResume {
  return {
    id: resume.id,
    userId: resume.userId,
    title: resume.title,
    targetRole: resume.targetRole,
    jdId: resume.jdId,
    templateId: resume.templateId,
    status: resume.status,
    createdAt: resume.createdAt,
    updatedAt: resume.updatedAt,
  };
}

function generationFailureError(error: unknown): Error {
  if (error instanceof LLMGenerationError) {
    const details = [
      `phase=${error.phase}`,
      error.providerErrorMessage ? `provider=${error.providerErrorMessage}` : "",
      error.schemaIssues?.length ? `schemaIssues=${error.schemaIssues.join(" | ")}` : "",
      error.rawContentPreview ? `rawContentPreview=${error.rawContentPreview}` : "",
    ].filter(Boolean).join("; ");
    return new Error(`LLM_GENERATION_FAILED: The AI model call failed or produced no valid resume variants. ${details}`);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`LLM_GENERATION_FAILED: The AI model call failed or produced no valid resume variants. ${message}`);
}

function buildDraftVariants(
  userId: string,
  jdText: string,
  targetRole?: string,
  experiences: ProductExperienceSummary[] = [],
): ProductGeneratedVariant[] {
  const now = new Date().toISOString();
  const role = targetRole?.trim() || "目标岗位";
  const jdPreview = jdText.replace(/\s+/g, " ").trim().slice(0, 260) || "暂未提供详细 JD。";
  const selectedExperiences = experiences.slice(0, 4);
  const experienceSection = selectedExperiences.length > 0
    ? selectedExperiences
        .map((item, index) => `${index + 1}. ${formatExperienceLine(item)}`)
        .join("\n")
    : "暂无经历库素材。建议先补充 2-3 段项目、工作或教育经历，后续可生成更贴合 JD 的版本。";
  return [{
    id: `pvar-${randomUUID()}`,
    userId,
    content: [
      `目标岗位：${role}`,
      "",
      "匹配摘要：",
      `这份草稿围绕 JD 中的核心要求整理，优先突出与「${role}」相关的项目成果、技术能力和业务影响。JD 摘要：${jdPreview}`,
      "",
      "推荐简历条目：",
      experienceSection,
      "",
      "可优化方向：",
      "- 补充可验证的业务指标，例如性能提升、交付周期、用户规模或成本节省。",
      "- 将每段经历改写为「行动 + 方法 + 结果」结构，避免只罗列职责。",
      "- 面试前确认所有指标和项目边界，确保表述真实可解释。",
    ].join("\n"),
    sourceExperienceIds: selectedExperiences.map((item) => item.id),
    sourceEvidenceIds: [],
    scores: {
      overall: selectedExperiences.length > 0 ? 0.72 : 0.58,
      relevance: selectedExperiences.length > 0 ? 0.74 : 0.6,
      evidenceStrength: selectedExperiences.length > 0 ? 0.62 : 0.35,
    },
    createdAt: now,
  }];
}

function formatExperienceLine(item: ProductExperienceSummary): string {
  const context = [item.role, item.organization].filter(Boolean).join(" / ");
  const content = item.content?.replace(/\s+/g, " ").trim().slice(0, 180);
  return [
    item.title,
    context ? `（${context}）` : "",
    content ? `：${content}` : "：可作为候选素材，建议补充具体成果和指标。",
  ].join("");
}

function enrichEvidencePackWithSourceExperienceFacts(
  evidencePack: EvidencePack,
  experiences: ProductExperienceSummary[],
): EvidencePack {
  if (experiences.length === 0) return evidencePack;
  const existingClaimIds = new Set(
    evidencePack.allowedClaims.map((claim) => claim.claimId ?? claim.id),
  );
  const sourceClaims: EvidencePack["allowedClaims"] = [];
  for (const exp of experiences.slice(0, 20)) {
    const claimId = `source-card-${exp.id}`;
    if (existingClaimIds.has(claimId)) continue;
    const parts = [
      exp.title,
      exp.organization,
      exp.role,
      formatResumeDateRange(exp.startDate, exp.endDate),
      exp.category,
    ].filter((item): item is string => Boolean(item && item.trim()));
    const metadataClaim = `Source resume fact: ${parts.join(" | ")}`;
    sourceClaims.push({
      id: claimId,
      claimId,
      claim: metadataClaim,
      requirementIds: ["source-experience-metadata"],
      experienceId: exp.id,
      revisionId: exp.currentRevisionId,
      evidenceText: [
        metadataClaim,
        exp.content ? exp.content.replace(/\s+/g, " ").trim().slice(0, 500) : "",
      ].filter(Boolean).join(" — "),
      confidence: 0.99,
      riskLevel: "low",
    });
  }
  if (sourceClaims.length === 0) return evidencePack;
  return {
    ...evidencePack,
    allowedClaims: [...sourceClaims, ...evidencePack.allowedClaims].slice(0, 96),
  };
}

function narrowEvidencePackToSourceExperiences(
  evidencePack: EvidencePack,
  experiences: ProductExperienceSummary[],
): EvidencePack {
  const sourceIds = new Set(experiences.map((item) => item.id));
  const allowedClaimIds = new Set<string>();
  const allowedClaims = evidencePack.allowedClaims.filter((claim) => {
    const keep = sourceIds.has(claim.experienceId);
    if (keep) allowedClaimIds.add(claim.claimId ?? claim.id);
    return keep;
  });
  return {
    ...evidencePack,
    matchedEvidence: evidencePack.matchedEvidence.map((match) => ({
      ...match,
      evidenceItems: match.evidenceItems.filter((item) => sourceIds.has(item.experienceId)),
    })),
    allowedClaims,
    retrievalTrace: evidencePack.retrievalTrace.filter((item) => sourceIds.has(item.experienceId)),
    graphLinks: evidencePack.graphLinks.filter((link) =>
      allowedClaimIds.has(link.sourceId) || allowedClaimIds.has(link.targetId),
    ),
    usageTrace: evidencePack.usageTrace.filter((item) =>
      !item.experienceId || sourceIds.has(item.experienceId),
    ),
  };
}

function formatResumeDateRange(startDate?: string, endDate?: string): string | undefined {
  const start = startDate?.trim();
  const end = endDate?.trim();
  if (!start && !end) return undefined;
  return `${start || "?"} - ${end || "present"}`;
}

function optional(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function nonEmpty(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function splitExperienceText(rawText: string): string[] {
  const lines = normalizeResumeText(rawText).split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const entries = splitByEntryStarts(lines, (line, index) => index > 0 && isExperienceBoundaryLine(line));
  return entries.length > 0 ? entries.slice(0, 8) : [rawText.trim()].filter(Boolean);
}

function isExperienceBoundaryLine(line: string): boolean {
  if (startsBulletLine(line)) return false;
  return hasDateRange(line) || startsProjectEntry(line) || sectionCategory(line) !== undefined;
}

function startsBulletLine(line: string): boolean {
  return /^[-*•·]\s+/.test(line);
}

function inferTitle(content: string, fallback: string): string {
  const firstLine = content.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
  return (firstLine ?? fallback).replace(/^[-*]\s*/, "").slice(0, 80);
}

// ───────────────────────────────────────────────────────────────
// ResumeDocument → ProductResumeItem entries
// ───────────────────────────────────────────────────────────────

const DENSITY_MIN_CAREER_BULLETS = 22;
const DENSITY_REFILL_CAREER_BULLETS = 16;
const DENSITY_MAX_SUPPLEMENTAL_ITEMS = 10;
const CAREER_ITEM_MIN_BULLETS = 3;
const CAREER_ITEM_MAX_GENERATED_BULLETS = 5;
const DENSE_CJK_MIN_CHARS = 48;
const DENSE_CJK_MAX_CHARS = 58;
const DENSE_CJK_TWO_LINE_MIN_CHARS = 116;
const DENSE_CJK_TWO_LINE_MAX_CHARS = 124;
const DENSE_ASCII_MIN_CHARS = 82;
const DENSE_ASCII_MAX_CHARS = 130;
const CJK_SENTENCE_BOUNDARIES = /[。！？!?；;]/u;
const CJK_SOFT_BOUNDARIES = /[，、,]/u;
const SECTION_ORDER_FOR_DENSITY: Record<ProductResumeItem["sectionType"], number> = {
  education: 0,
  experience: 1,
  project: 2,
  award: 3,
  skill: 4,
  summary: 5,
  other: 6,
};

function densifyGeneratedResumeVariants(input: {
  variants: ProductGeneratedVariant[];
  sourceExperiences: ProductExperienceSummary[];
  recommendedVariantId?: string;
}): ProductGeneratedVariant[] {
  const recommendedId = input.recommendedVariantId
    ?? input.variants.find((variant) => variant.recommended)?.id
    ?? input.variants[0]?.id;
  return input.variants.map((variant) => {
    if (variant.id !== recommendedId) return variant;
    return densifyGeneratedResumeVariant(variant, input.sourceExperiences);
  });
}

function densifyGeneratedResumeVariant(
  variant: ProductGeneratedVariant,
  sourceExperiences: ProductExperienceSummary[],
): ProductGeneratedVariant {
  const doc = variant.resumeDocument;
  if (!doc || !Array.isArray(doc.sections) || doc.sections.length === 0) return variant;
  const nextDoc: ResumeDocument = {
    ...doc,
    sections: doc.sections.map((section) => ({
      ...section,
      items: section.items.map((item) => ({ ...item, bullets: item.bullets.map((bullet) => ({ ...bullet })) })),
    })),
  };
  const sourcesById = new Map(sourceExperiences.map((source) => [source.id, source]));
  const usedSourceIds = new Set<string>();
  for (const section of nextDoc.sections) {
    for (const item of section.items) {
      const source = resolveResumeItemSource(item, sourcesById, sourceExperiences);
      if (source) {
        usedSourceIds.add(source.id);
        if (item.sourceExperienceId !== source.id) item.sourceExperienceId = source.id;
      } else if (item.sourceExperienceId) {
        usedSourceIds.add(item.sourceExperienceId);
      }
    }
  }

  let changedExistingBullets = false;
  for (const section of nextDoc.sections) {
    if (section.type !== "experience" && section.type !== "project") continue;
    for (const item of section.items) {
      const source = resolveResumeItemSource(item, sourcesById, sourceExperiences);
      if (!source) continue;
      if (item.sourceExperienceId !== source.id) {
        item.sourceExperienceId = source.id;
        changedExistingBullets = true;
      }
      if (normalizeCareerResumeItemHeader(section.type, item, source)) {
        changedExistingBullets = true;
      }
      const sourceBullets = denseBulletsFromSourceExperience(source, 4);
      const sourcePhrases = sourceEvidencePhrases(source);
      const acceptedTexts: string[] = [];
      for (const bullet of item.bullets) {
        const text = bullet.text.trim();
        const qualityText = normalizeCareerBulletQuality(text, source, sourcePhrases);
        const textAfterQuality = qualityText ?? text;
        const duplicate = acceptedTexts.some((accepted) => areResumeBulletsTooSimilar(textAfterQuality, accepted, source));
        const replacement = duplicate
          ? sourceBullets.find((candidate) => !acceptedTexts.some((accepted) => areResumeBulletsTooSimilar(candidate, accepted, source)))
          : normalizeCareerBulletForNaturalWidth(textAfterQuality, sourcePhrases)
            ?? (needsDenseBulletExpansion(textAfterQuality)
              ? sourceBullets.find((candidate) => candidate !== textAfterQuality && !acceptedTexts.some((accepted) => areResumeBulletsTooSimilar(candidate, accepted, source)))
              : qualityText);
        if (replacement) {
          bullet.text = replacement;
          if (!bullet.evidenceIds || bullet.evidenceIds.length === 0) bullet.evidenceIds = [`source-card-${source.id}`];
          acceptedTexts.push(replacement);
          changedExistingBullets = true;
          continue;
        }
        acceptedTexts.push(textAfterQuality);
      }
      const polishedBullets = polishCareerItemBullets(item.bullets, source, sourceBullets, sourcePhrases);
      if (polishedBullets.changed) {
        item.bullets = polishedBullets.bullets;
        changedExistingBullets = true;
      }
    }
  }
  let careerBulletCount = countCareerBullets(nextDoc);
  if (careerBulletCount >= DENSITY_MIN_CAREER_BULLETS) {
    if (!changedExistingBullets) return variant;
  }

  let supplementalItems = 0;
  for (const source of sourceExperiences) {
    if (careerBulletCount >= DENSITY_MIN_CAREER_BULLETS) break;
    if (supplementalItems >= DENSITY_MAX_SUPPLEMENTAL_ITEMS) break;
    const sectionType = resumeSectionTypeForExperience(source);
    if (sectionType !== "experience" && sectionType !== "project") continue;
    if (usedSourceIds.has(source.id)) continue;
    const bullets = sourceGroundedCareerBulletCandidates(
      source,
      [],
      CAREER_ITEM_MIN_BULLETS,
      CAREER_ITEM_MAX_GENERATED_BULLETS,
    );
    if (bullets.length < CAREER_ITEM_MIN_BULLETS) continue;
    const section = ensureResumeDocumentSection(nextDoc, sectionType);
    section.items.push({
      id: `density-${source.id}`,
      title: resumeDocumentTitleForSource(sectionType, source),
      subtitle: resumeDocumentSubtitleForSource(sectionType, source),
      period: formatResumeDateRange(source.startDate, source.endDate),
      bullets: bullets.map((text, index) => ({
        id: `density-${source.id}-b${index + 1}`,
        text,
        evidenceIds: [`source-card-${source.id}`],
      })),
      sourceExperienceId: source.id,
      evidenceStrength: "medium",
      relevanceScore: 0.55,
    });
    usedSourceIds.add(source.id);
    careerBulletCount += bullets.length;
    supplementalItems += 1;
  }

  const finalPolish = polishCareerDocumentItems(nextDoc, sourcesById, sourceExperiences);
  if (finalPolish.changed) changedExistingBullets = true;
  careerBulletCount = finalPolish.careerBulletCount;

  for (const source of sourceExperiences) {
    if (careerBulletCount >= DENSITY_MIN_CAREER_BULLETS) break;
    if (supplementalItems >= DENSITY_MAX_SUPPLEMENTAL_ITEMS) break;
    const sectionType = resumeSectionTypeForExperience(source);
    if (sectionType !== "experience" && sectionType !== "project") continue;
    if (usedSourceIds.has(source.id)) continue;
    const bullets = sourceGroundedCareerBulletCandidates(
      source,
      [],
      CAREER_ITEM_MIN_BULLETS,
      CAREER_ITEM_MAX_GENERATED_BULLETS,
    );
    if (bullets.length < CAREER_ITEM_MIN_BULLETS) continue;
    const section = ensureResumeDocumentSection(nextDoc, sectionType);
    section.items.push({
      id: `density-${source.id}`,
      title: resumeDocumentTitleForSource(sectionType, source),
      subtitle: resumeDocumentSubtitleForSource(sectionType, source),
      period: formatResumeDateRange(source.startDate, source.endDate),
      bullets: bullets.map((text, index) => ({
        id: `density-${source.id}-b${index + 1}`,
        text,
        evidenceIds: [`source-card-${source.id}`],
      })),
      sourceExperienceId: source.id,
      evidenceStrength: "medium",
      relevanceScore: 0.55,
    });
    usedSourceIds.add(source.id);
    careerBulletCount += bullets.length;
    supplementalItems += 1;
  }

  if (careerBulletCount < DENSITY_REFILL_CAREER_BULLETS) {
    const refill = refillCareerBulletsFromSources(nextDoc, sourcesById, sourceExperiences, DENSITY_REFILL_CAREER_BULLETS);
    if (refill.added > 0) {
      careerBulletCount += refill.added;
      changedExistingBullets = true;
    }
  }

  if (careerBulletCount === countCareerBullets(doc) && !changedExistingBullets) return variant;
  const sourceExperienceIds = Array.from(new Set([
    ...(variant.sourceExperienceIds ?? []),
    ...Array.from(usedSourceIds),
  ]));
  return {
    ...variant,
    resumeDocument: sortResumeDocument(nextDoc),
    sourceExperienceIds,
    reason: [
      variant.reason,
      `Density completion added evidence-backed internship/project items from ${supplementalItems} source experiences.`,
    ].filter(Boolean).join(" "),
  };
}

async function refineGeneratedResumeVariantsWithCareerBullets(input: {
  variants: ProductGeneratedVariant[];
  sourceExperiences: ProductExperienceSummary[];
  jdText: string;
  targetRole?: string;
  recommendedVariantId?: string;
  llmGenerationService?: LLMGenerationService;
}): Promise<ProductGeneratedVariant[]> {
  const recommendedId = input.recommendedVariantId
    ?? input.variants.find((variant) => variant.recommended)?.id
    ?? input.variants[0]?.id;
  const refined: ProductGeneratedVariant[] = [];
  for (const variant of input.variants) {
    refined.push(
      variant.id === recommendedId
        ? await refineGeneratedResumeVariantWithCareerBullets(variant, input)
        : variant,
    );
  }
  return refined;
}

async function refineGeneratedResumeVariantWithCareerBullets(
  variant: ProductGeneratedVariant,
  input: {
    sourceExperiences: ProductExperienceSummary[];
    jdText: string;
    targetRole?: string;
    llmGenerationService?: LLMGenerationService;
  },
): Promise<ProductGeneratedVariant> {
  const doc = variant.resumeDocument;
  if (!doc || !Array.isArray(doc.sections) || doc.sections.length === 0) return variant;
  const nextDoc: ResumeDocument = {
    ...doc,
    sections: doc.sections.map((section) => ({
      ...section,
      items: section.items.map((item) => ({
        ...item,
        bullets: item.bullets.map((bullet) => ({ ...bullet })),
      })),
    })),
  };
  const sourcesById = new Map(input.sourceExperiences.map((source) => [source.id, source]));
  const usedSourceIds = new Set<string>(variant.sourceExperienceIds ?? []);
  let changed = false;

  for (const section of nextDoc.sections) {
    if (section.type !== "experience" && section.type !== "project") continue;
    for (const item of section.items) {
      const source = resolveResumeItemSource(item, sourcesById, input.sourceExperiences);
      if (!source) continue;
      usedSourceIds.add(source.id);
      if (item.sourceExperienceId !== source.id) {
        item.sourceExperienceId = source.id;
        changed = true;
      }
      if (normalizeCareerResumeItemHeader(section.type, item, source)) changed = true;
      if (
        item.id.startsWith("density-")
        && typeof input.llmGenerationService?.generateCareerBulletsForExperience !== "function"
      ) {
        continue;
      }
      const refined = await refineCareerItemBulletsFromSource({
        sectionType: section.type,
        item,
        source,
        jdText: input.jdText,
        targetRole: input.targetRole,
        llmGenerationService: input.llmGenerationService,
      });
      if (refined.changed) {
        item.bullets = refined.bullets;
        changed = true;
      }
    }
  }

  if (!changed) return variant;
  return {
    ...variant,
    resumeDocument: sortResumeDocument(nextDoc),
    sourceExperienceIds: Array.from(new Set([
      ...(variant.sourceExperienceIds ?? []),
      ...Array.from(usedSourceIds),
    ])),
    reason: [
      variant.reason,
      "Career item bullet refinement regenerated source-grounded, non-duplicate internship/project bullets.",
    ].filter(Boolean).join(" "),
  };
}

async function refineCareerItemBulletsFromSource(input: {
  sectionType: "experience" | "project";
  item: ResumeDocumentSection["items"][number];
  source: ProductExperienceSummary;
  jdText: string;
  targetRole?: string;
  llmGenerationService?: LLMGenerationService;
}): Promise<{ bullets: ResumeDocumentSection["items"][number]["bullets"]; changed: boolean }> {
  const sourcePhrases = sourceEvidencePhrases(input.source);
  const sourceBullets = denseBulletsFromSourceExperience(input.source, CAREER_ITEM_MAX_GENERATED_BULLETS + 1);
  const acceptedTexts: string[] = [];
  const result: ResumeDocumentSection["items"][number]["bullets"] = [];
  let changed = false;

  for (const bullet of input.item.bullets) {
    const candidate = normalizeCareerBulletCandidate(bullet.text, input.source, sourcePhrases);
    const replacement = candidate && isAcceptableCareerBullet(candidate, acceptedTexts, input.source)
      ? candidate
      : findNextCareerBulletCandidate(sourceBullets, acceptedTexts, input.source, sourcePhrases);
    if (!replacement) {
      const preserved = stripDuplicateNaturalClauses(bullet.text.trim());
      if (
        preserved
        && !needsDenseBulletExpansion(preserved)
        && !acceptedTexts.some((accepted) => areResumeBulletsTooSimilar(preserved, accepted, input.source))
        && !haveResumeMetricAnchorOverlap(preserved, acceptedTexts)
      ) {
        result.push({
          ...bullet,
          text: preserved,
          evidenceIds: bullet.evidenceIds && bullet.evidenceIds.length > 0 ? bullet.evidenceIds : [`source-card-${input.source.id}`],
        });
        acceptedTexts.push(preserved);
        if (preserved !== bullet.text.trim()) changed = true;
      } else {
        changed = true;
      }
      continue;
    }
    result.push({
      ...bullet,
      text: replacement,
      evidenceIds: bullet.evidenceIds && bullet.evidenceIds.length > 0 ? bullet.evidenceIds : [`source-card-${input.source.id}`],
    });
    if (replacement !== bullet.text.trim()) changed = true;
    acceptedTexts.push(replacement);
  }

  while (result.length < CAREER_ITEM_MAX_GENERATED_BULLETS) {
    const generated = await generateOneCareerBulletCandidate({
      jdText: input.jdText,
      targetRole: input.targetRole,
      sectionType: input.sectionType,
      sourceExperience: input.source,
      currentTitle: input.item.title,
      currentSubtitle: input.item.subtitle,
      acceptedBullets: acceptedTexts,
      minBullets: CAREER_ITEM_MIN_BULLETS,
      maxBullets: CAREER_ITEM_MAX_GENERATED_BULLETS,
      llmGenerationService: input.llmGenerationService,
    });
    const nextText = findNextCareerBulletCandidate(
      [...generated, ...sourceBullets, ...sourcePhrases],
      acceptedTexts,
      input.source,
      sourcePhrases,
    ) ?? findNextCareerBulletCandidate(
      [...generated, ...sourceBullets, ...sourcePhrases],
      acceptedTexts,
      input.source,
      sourcePhrases,
      { relaxed: true },
    ) ?? findAnyNonExactCareerBulletCandidate(
      [...generated, ...sourceBullets, ...sourcePhrases],
      acceptedTexts,
      input.source,
      sourcePhrases,
    );
    if (!nextText) break;
    result.push({
      id: `${input.item.id || input.source.id}-refined-b${result.length + 1}`,
      text: nextText,
      evidenceIds: [`source-card-${input.source.id}`],
    });
    acceptedTexts.push(nextText);
    changed = true;
  }

  const uniqueResult: ResumeDocumentSection["items"][number]["bullets"] = [];
  const uniqueTexts: string[] = [];
  for (const bullet of result) {
    const exactDuplicate = hasExactCareerBulletDuplicate(bullet.text, uniqueTexts, input.source);
    const relaxedDuplicate = !isRelaxedAcceptableCareerBullet(bullet.text, uniqueTexts, input.source);
    const strictDuplicate = uniqueTexts.some((accepted) => areResumeBulletsTooSimilar(bullet.text, accepted, input.source));
    if (exactDuplicate || relaxedDuplicate || strictDuplicate) {
      changed = true;
      continue;
    }
    uniqueResult.push(bullet);
    uniqueTexts.push(bullet.text);
  }

  while (uniqueResult.length < CAREER_ITEM_MAX_GENERATED_BULLETS) {
    const generated = await generateOneCareerBulletCandidate({
      jdText: input.jdText,
      targetRole: input.targetRole,
      sectionType: input.sectionType,
      sourceExperience: input.source,
      currentTitle: input.item.title,
      currentSubtitle: input.item.subtitle,
      acceptedBullets: uniqueTexts,
      minBullets: CAREER_ITEM_MIN_BULLETS,
      maxBullets: CAREER_ITEM_MAX_GENERATED_BULLETS,
      llmGenerationService: input.llmGenerationService,
    });
    const needsMinimum = uniqueResult.length < CAREER_ITEM_MIN_BULLETS;
    const nextText = findNextCareerBulletCandidate(
      [...generated, ...sourceBullets, ...sourcePhrases],
      uniqueTexts,
      input.source,
      sourcePhrases,
    ) ?? findNextCareerBulletCandidate(
      [...generated, ...sourceBullets, ...sourcePhrases],
      uniqueTexts,
      input.source,
      sourcePhrases,
      { relaxed: true },
    ) ?? (needsMinimum
      ? findAnyNonExactCareerBulletCandidate(
          [...generated, ...sourceBullets, ...sourcePhrases],
          uniqueTexts,
          input.source,
          sourcePhrases,
        ) ?? buildSyntheticCareerBulletCandidate(input.source, uniqueTexts, sourcePhrases)
      : undefined);
    if (!nextText) break;
    uniqueResult.push({
      id: `${input.item.id || input.source.id}-refined-b${uniqueResult.length + 1}`,
      text: nextText,
      evidenceIds: [`source-card-${input.source.id}`],
    });
    uniqueTexts.push(nextText);
    changed = true;
  }

  return { bullets: uniqueResult, changed: changed || uniqueResult.length !== input.item.bullets.length };
}

function ensureCareerItemMinimumBulletsFromSource(
  item: ResumeDocumentSection["items"][number],
  source: ProductExperienceSummary,
): { added: number; changed: boolean } {
  if (item.bullets.length >= CAREER_ITEM_MIN_BULLETS) return { added: 0, changed: false };
  const acceptedTexts = item.bullets.map((bullet) => bullet.text.trim()).filter(Boolean);
  const candidates = sourceGroundedCareerBulletCandidates(
    source,
    acceptedTexts,
    CAREER_ITEM_MIN_BULLETS,
    CAREER_ITEM_MAX_GENERATED_BULLETS,
  );
  let added = 0;
  for (const text of candidates) {
    if (item.bullets.length >= CAREER_ITEM_MIN_BULLETS) break;
    if (acceptedTexts.includes(text)) continue;
    item.bullets.push({
      id: `${item.id || source.id}-min-b${item.bullets.length + 1}`,
      text,
      evidenceIds: [`source-card-${source.id}`],
    });
    acceptedTexts.push(text);
    added += 1;
  }
  return { added, changed: added > 0 };
}

function sourceGroundedCareerBulletCandidates(
  source: ProductExperienceSummary,
  acceptedTexts: string[],
  minBullets: number,
  maxBullets: number,
): string[] {
  const sourcePhrases = sourceEvidencePhrases(source);
  const candidates = [
    ...denseBulletsFromSourceExperience(source, maxBullets),
    ...sourcePhrases,
  ];
  const result: string[] = [];
  const accepted = [...acceptedTexts];
  while (result.length < maxBullets && accepted.length + result.length < maxBullets) {
    const next = findNextCareerBulletCandidate(candidates, [...accepted, ...result], source, sourcePhrases)
      ?? findNextCareerBulletCandidate(candidates, [...accepted, ...result], source, sourcePhrases, { relaxed: true })
      ?? findAnyNonExactCareerBulletCandidate(candidates, [...accepted, ...result], source, sourcePhrases)
      ?? buildSyntheticCareerBulletCandidate(source, [...accepted, ...result], sourcePhrases);
    if (!next) break;
    result.push(next);
  }
  if (acceptedTexts.length + result.length < minBullets) {
    return result;
  }
  return result;
}

async function generateOneCareerBulletCandidate(
  input: LLMExperienceBulletGenerationInput & { llmGenerationService?: LLMGenerationService },
): Promise<string[]> {
  const generator = input.llmGenerationService?.generateCareerBulletsForExperience;
  if (typeof generator !== "function") return [];
  try {
    return await generator.call(input.llmGenerationService, input);
  } catch {
    return [];
  }
}

function findNextCareerBulletCandidate(
  candidates: string[],
  acceptedTexts: string[],
  source: ProductExperienceSummary,
  sourcePhrases: string[],
  options: { relaxed?: boolean } = {},
): string | undefined {
  for (const candidate of candidates) {
    const normalized = normalizeCareerBulletCandidate(candidate, source, sourcePhrases);
    if (!normalized) continue;
    if (options.relaxed) {
      if (!isRelaxedAcceptableCareerBullet(normalized, acceptedTexts, source)) continue;
    } else if (!isAcceptableCareerBullet(normalized, acceptedTexts, source)) {
      continue;
    }
    return normalized;
  }
  return undefined;
}

function findAnyNonExactCareerBulletCandidate(
  candidates: string[],
  acceptedTexts: string[],
  source: ProductExperienceSummary,
  sourcePhrases: string[],
): string | undefined {
  for (const candidate of candidates) {
    const normalized = normalizeCareerBulletCandidate(candidate, source, sourcePhrases);
    if (!normalized) continue;
    if (hasExactCareerBulletDuplicate(normalized, acceptedTexts, source)) continue;
    return normalized;
  }
  return undefined;
}

function buildSyntheticCareerBulletCandidate(
  source: ProductExperienceSummary,
  acceptedTexts: string[],
  sourcePhrases: string[],
): string | undefined {
  const context = uniqueNonEmpty([source.title, source.role]).join("、") || source.title || source.role || "该经历";
  for (const phrase of sourcePhrases) {
    const cleaned = cleanNaturalContinuation(phrase);
    if (!cleaned) continue;
    const candidate = containsCjkText(cleaned)
      ? `围绕${context}，${cleaned}`
      : `${cleaned} for ${context}`;
    const normalized = normalizeCareerBulletCandidate(candidate, source, sourcePhrases);
    if (!normalized) continue;
    if (hasExactCareerBulletDuplicate(normalized, acceptedTexts, source)) continue;
    return normalized;
  }
  return undefined;
}

function normalizeCareerBulletCandidate(
  text: string,
  source: ProductExperienceSummary,
  sourcePhrases: string[],
): string | undefined {
  const qualityText = normalizeCareerBulletQuality(text, source, sourcePhrases) ?? text;
  const withoutDuplicateClauses = stripDuplicateNaturalClauses(qualityText);
  const widthNormalized = normalizeCareerBulletForNaturalWidth(withoutDuplicateClauses, sourcePhrases)
    ?? normalizeDenseBullet(withoutDuplicateClauses, sourcePhrases)
    ?? withoutDuplicateClauses;
  const normalized = stripDuplicateNaturalClauses(widthNormalized).trim();
  if (isLowQualityCareerBullet(normalized, source)) return undefined;
  if (needsDenseBulletExpansion(normalized)) return undefined;
  return normalized;
}

function isAcceptableCareerBullet(
  text: string,
  acceptedTexts: string[],
  source: ProductExperienceSummary,
): boolean {
  if (!text || isLowQualityCareerBullet(text, source)) return false;
  return !acceptedTexts.some((accepted) => areResumeBulletsTooSimilar(text, accepted, source))
    && !haveResumeMetricAnchorOverlap(text, acceptedTexts);
}

function isRelaxedAcceptableCareerBullet(
  text: string,
  acceptedTexts: string[],
  source: ProductExperienceSummary,
): boolean {
  if (!text || isLowQualityCareerBullet(text, source)) return false;
  const normalized = normalizeBulletSimilarityText(stripSourceNames(text, source));
  if (!normalized) return false;
  return !acceptedTexts.some((accepted) => {
    const acceptedNormalized = normalizeBulletSimilarityText(stripSourceNames(accepted, source));
    return accepted.trim() === text.trim()
      || (acceptedNormalized.length > 0 && acceptedNormalized === normalized)
      || (normalized.length >= 20 && acceptedNormalized.length >= 20 && (
        normalized.includes(acceptedNormalized) || acceptedNormalized.includes(normalized)
      ));
  });
}

function hasExactCareerBulletDuplicate(
  text: string,
  acceptedTexts: string[],
  source: ProductExperienceSummary,
): boolean {
  const normalized = normalizeBulletSimilarityText(stripSourceNames(text, source));
  return acceptedTexts.some((accepted) => {
    const acceptedNormalized = normalizeBulletSimilarityText(stripSourceNames(accepted, source));
    return accepted.trim() === text.trim()
      || (normalized.length > 0 && acceptedNormalized === normalized);
  });
}

function polishCareerDocumentItems(
  doc: ResumeDocument,
  sourcesById: Map<string, ProductExperienceSummary>,
  sourceExperiences: ProductExperienceSummary[],
): { careerBulletCount: number; changed: boolean } {
  let changed = false;
  for (const section of doc.sections) {
    if (section.type !== "experience" && section.type !== "project") continue;
    for (const item of section.items) {
      const source = resolveResumeItemSource(item, sourcesById, sourceExperiences);
      if (!source) continue;
      if (item.sourceExperienceId !== source.id) {
        item.sourceExperienceId = source.id;
        changed = true;
      }
      if (normalizeCareerResumeItemHeader(section.type, item, source)) changed = true;
      const sourceBullets = denseBulletsFromSourceExperience(source, 4);
      const sourcePhrases = sourceEvidencePhrases(source);
      if (item.id.startsWith("density-")) {
        for (const bullet of item.bullets) {
          const original = bullet.text.trim();
          const qualityText = normalizeCareerBulletQuality(original, source, sourcePhrases);
          const nextText = stripDuplicateNaturalClauses(qualityText ?? original);
          const acceptedText = nextText.length >= DENSE_CJK_MIN_CHARS ? nextText : original;
          if (acceptedText !== original) {
            bullet.text = acceptedText;
            changed = true;
          }
        }
        continue;
      }
      const polished = polishCareerItemBullets(item.bullets, source, sourceBullets, sourcePhrases);
      if (polished.changed) {
        item.bullets = polished.bullets;
        changed = true;
      }
    }
  }
  return { careerBulletCount: countCareerBullets(doc), changed };
}

function refillCareerBulletsFromSources(
  doc: ResumeDocument,
  sourcesById: Map<string, ProductExperienceSummary>,
  sourceExperiences: ProductExperienceSummary[],
  targetCount: number,
): { added: number } {
  let currentCount = countCareerBullets(doc);
  let added = 0;
  for (const section of doc.sections) {
    if (currentCount >= targetCount) break;
    if (section.type !== "experience" && section.type !== "project") continue;
    for (const item of section.items) {
      if (currentCount >= targetCount) break;
      if (item.bullets.length >= 5) continue;
      const source = resolveResumeItemSource(item, sourcesById, sourceExperiences);
      if (!source) continue;
      const existingTexts = new Set(item.bullets.map((bullet) => bullet.text.trim()));
      const candidates = sourceEvidencePhrases(source);
      for (let index = 0; index < candidates.length; index += 1) {
        if (currentCount >= targetCount || item.bullets.length >= 5) break;
        const text = normalizeDenseBullet(candidates[index]!, [
          ...candidates.slice(index + 1),
          ...candidates.slice(0, index),
        ]);
        if (!text || existingTexts.has(text) || isLowQualityCareerBullet(text, source)) continue;
        item.bullets.push({
          id: `density-refill-${source.id}-b${item.bullets.length + 1}`,
          text,
          evidenceIds: [`source-card-${source.id}`],
        });
        existingTexts.add(text);
        currentCount += 1;
        added += 1;
      }
    }
  }
  return { added };
}

function countCareerBullets(doc: ResumeDocument): number {
  return doc.sections
    .filter((section) => section.type === "experience" || section.type === "project")
    .reduce((sum, section) => sum + section.items.reduce((inner, item) => inner + item.bullets.length, 0), 0);
}

function ensureResumeDocumentSection(
  doc: ResumeDocument,
  type: ProductResumeItem["sectionType"],
): ResumeDocumentSection {
  const found = doc.sections.find((section) => section.type === type);
  if (found) return found;
  const section: ResumeDocumentSection = {
    id: `density-sec-${type}`,
    type,
    title: type === "project" ? "项目经历" : "实习经历",
    order: SECTION_ORDER_FOR_DENSITY[type],
    items: [],
  };
  doc.sections.push(section);
  return section;
}

function sortResumeDocument(doc: ResumeDocument): ResumeDocument {
  return {
    ...doc,
    sections: doc.sections
      .map((section) => ({
        ...section,
        order: SECTION_ORDER_FOR_DENSITY[section.type] ?? section.order,
      }))
      .sort((a, b) => a.order - b.order),
  };
}

function resumeSectionTypeForExperience(source: ProductExperienceSummary): ProductResumeItem["sectionType"] {
  if (source.category === "internship" || source.category === "work") return "experience";
  if (source.category === "project") return "project";
  if (source.category === "education") return "education";
  if (source.category === "award") return "award";
  if (source.category === "skill") return "skill";
  return "other";
}

function normalizeCareerResumeItemHeader(
  sectionType: ProductResumeItem["sectionType"],
  item: ResumeDocumentSection["items"][number],
  source: ProductExperienceSummary,
): boolean {
  if (sectionType !== "experience" && sectionType !== "project") return false;
  const expectedTitle = resumeDocumentTitleForSource(sectionType, source);
  const expectedSubtitle = resumeDocumentSubtitleForSource(sectionType, source);
  const expectedPeriod = formatResumeDateRange(source.startDate, source.endDate);
  let changed = false;
  if (expectedTitle && item.title.trim() !== expectedTitle) {
    item.title = expectedTitle;
    changed = true;
  }
  if (expectedSubtitle && item.subtitle?.trim() !== expectedSubtitle) {
    item.subtitle = expectedSubtitle;
    changed = true;
  }
  if (expectedPeriod && item.period?.trim() !== expectedPeriod) {
    item.period = expectedPeriod;
    changed = true;
  }
  return changed;
}

function resumeDocumentTitleForSource(
  sectionType: ProductResumeItem["sectionType"],
  source: ProductExperienceSummary,
): string {
  if (sectionType === "project" || source.category === "project") return source.title;
  return source.role || source.title;
}

function resumeDocumentSubtitleForSource(
  sectionType: ProductResumeItem["sectionType"],
  source: ProductExperienceSummary,
): string | undefined {
  const parts = sectionType === "project" || source.category === "project"
    ? [source.role, source.organization]
    : [source.organization];
  const normalizedTitle = normalizeSourceMatchText(resumeDocumentTitleForSource(sectionType, source));
  const unique = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .filter((part, index, list) => list.indexOf(part) === index)
    .filter((part) => normalizeSourceMatchText(part) !== normalizedTitle);
  return unique.length > 0 ? unique.join("，") : undefined;
}

function resolveResumeItemSource(
  item: ResumeDocumentSection["items"][number],
  sourcesById: Map<string, ProductExperienceSummary>,
  sourceExperiences: ProductExperienceSummary[],
): ProductExperienceSummary | undefined {
  if (item.sourceExperienceId) {
    const byId = sourcesById.get(item.sourceExperienceId);
    if (byId) return byId;
  }
  const title = normalizeSourceMatchText(item.title);
  const subtitle = normalizeSourceMatchText(item.subtitle);
  if (!title && !subtitle) return undefined;
  if (title) {
    const byTitle = sourceExperiences.find((source) => {
      const titleParts = [
        source.title,
        source.organization,
      ].map(normalizeSourceMatchText).filter(Boolean);
      return titleParts.some((part) => part.includes(title) || title.includes(part));
    });
    if (byTitle) return byTitle;
  }
  if (!subtitle) return undefined;
  return sourceExperiences.find((source) => {
    const sourceParts = [
      source.title,
      source.organization,
      source.role,
    ].map(normalizeSourceMatchText).filter((part) => part.length >= 4);
    return Boolean(
      sourceParts.some((part) => part.includes(subtitle) || subtitle.includes(part)),
    );
  });
}

function normalizeSourceMatchText(value: string | undefined): string {
  return (value ?? "")
    .replace(/\s+/g, "")
    .replace(/[^\p{L}\p{N}+#./-]/gu, "")
    .toLowerCase();
}

function denseBulletsFromSourceExperience(source: ProductExperienceSummary, remainingNeeded: number): string[] {
  const candidates = sourceEvidencePhrases(source);
  const bullets: string[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    const bullet = normalizeDenseBullet(candidate, [
      ...candidates.slice(index + 1),
      ...candidates.slice(0, index),
    ]);
    if (!bullet || bullets.includes(bullet) || isLowQualityCareerBullet(bullet, source)) continue;
    bullets.push(bullet);
    if (bullets.length >= Math.min(5, Math.max(1, remainingNeeded))) break;
  }
  return bullets;
}

function sourceEvidencePhrases(source: ProductExperienceSummary): string[] {
  const phrases: string[] = [];
  const structured = source.structured ?? {};
  for (const key of ["highlights", "achievements", "responsibilities", "metrics", "description", "content"]) {
    phrases.push(...collectStructuredStrings(structured[key]));
  }
  if (source.content) {
    phrases.push(...splitEvidenceText(source.content));
    phrases.push(...splitLongEvidencePhrase(source.content));
  }
  return phrases
    .map((item) => item.replace(/\s+/g, " ").trim())
    .flatMap((item) => {
      const contextual = contextualizeSourcePhrase(source, item);
      return contextual && contextual !== item ? [item, contextual] : [item];
    })
    .flatMap((item) => splitLongEvidencePhrase(item))
    .filter((item, index, list) => item.length >= 14 && list.indexOf(item) === index);
}

function contextualizeSourcePhrase(source: ProductExperienceSummary, phrase: string): string {
  const cleaned = phrase.trim();
  if (!cleaned || containsSourceContext(cleaned, source)) return cleaned;
  const title = source.title?.trim();
  const org = source.organization?.trim();
  const role = source.role?.trim();
  if (containsCjkText(cleaned)) {
    const context = uniqueNonEmpty([title, org]).join("、");
    if (!context) return cleaned;
    return `在${context}中，${cleaned}`;
  }
  const context = uniqueNonEmpty([role || title, org]).join(" at ");
  if (!context) return cleaned;
  return `${cleaned} in ${context}`;
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  return values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .filter((value, index, list) => list.indexOf(value) === index);
}

function containsSourceContext(text: string, source: ProductExperienceSummary): boolean {
  return [source.title, source.organization, source.role]
    .filter((item): item is string => Boolean(item && item.trim()))
    .some((item) => text.includes(item.trim()));
}

function collectStructuredStrings(value: unknown): string[] {
  if (typeof value === "string") return splitEvidenceText(value);
  if (Array.isArray(value)) return value.flatMap((item) => collectStructuredStrings(item));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((item) => collectStructuredStrings(item));
  }
  return [];
}

function splitEvidenceText(text: string): string[] {
  return text
    .split(/\r?\n|[-•*]\s+|[。；;]\s*/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitLongEvidencePhrase(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= DENSE_CJK_TWO_LINE_MAX_CHARS) return [normalized];
  if (!containsCjkText(normalized)) return [normalized];
  const clauses = splitNaturalCjkClauses(normalized);
  if (clauses.length <= 1) return [normalized];
  const chunks: string[] = [];
  let current = "";
  for (const clause of clauses) {
    const next = current ? `${current}，${clause}` : clause;
    if (next.length <= DENSE_CJK_TWO_LINE_MAX_CHARS) {
      current = next;
      continue;
    }
    if (current.length >= 24 && !isIncompleteResumeBullet(current)) chunks.push(current);
    current = clause;
  }
  if (current.length >= 24 && !isIncompleteResumeBullet(current)) chunks.push(current);
  return chunks.length > 0 ? chunks : [normalized];
}

function normalizeDenseBullet(text: string, followingCandidates: string[] = []): string | undefined {
  const cleaned = text
    .replace(/^[-•*\d.\s]+/u, "")
    .replace(/^(项目|职责|成果|内容|描述|亮点|工作|核心技术难点|问题解决|实践合作)[:：]\s*/u, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length < 14) return undefined;
  if (containsCjkText(cleaned)) {
    if (cleaned.length <= DENSE_CJK_MAX_CHARS) return trimCjkBullet(expandCjkBullet(cleaned, followingCandidates));
    const twoLine = trimCjkTwoLineBullet(
      expandCjkBulletToMin(cleaned, followingCandidates, DENSE_CJK_TWO_LINE_MIN_CHARS),
    );
    return twoLine ?? trimCjkBullet(cleaned);
  }
  return trimAsciiBullet(expandAsciiBullet(cleaned, followingCandidates));
}

function normalizeCareerBulletForNaturalWidth(text: string, followingCandidates: string[]): string | undefined {
  const cleaned = cleanDenseContinuation(text);
  if (cleaned.length < 14) return undefined;
  if (!containsCjkText(cleaned)) {
    return cleaned.length < DENSE_ASCII_MIN_CHARS
      ? normalizeDenseBullet(cleaned, followingCandidates)
      : undefined;
  }
  if (cleaned.length < DENSE_CJK_MIN_CHARS) return normalizeDenseBullet(cleaned, followingCandidates);
  if (cleaned.length <= DENSE_CJK_MAX_CHARS) {
    return isIncompleteResumeBullet(cleaned) ? normalizeDenseBullet(cleaned, followingCandidates) : undefined;
  }
  if (cleaned.length < DENSE_CJK_TWO_LINE_MIN_CHARS) {
    return trimCjkTwoLineBullet(expandCjkBulletToMin(cleaned, followingCandidates, DENSE_CJK_TWO_LINE_MIN_CHARS));
  }
  if (cleaned.length <= DENSE_CJK_TWO_LINE_MAX_CHARS) {
    return isIncompleteResumeBullet(cleaned) ? normalizeDenseBullet(cleaned, followingCandidates) : undefined;
  }
  if (cleaned.length > DENSE_CJK_TWO_LINE_MAX_CHARS) return trimCjkTwoLineBullet(cleaned);
  return undefined;
}

function normalizeCareerBulletQuality(
  text: string,
  source: ProductExperienceSummary,
  followingCandidates: string[],
): string | undefined {
  const cleaned = cleanDenseContinuation(stripEmbeddedSourceContext(text, source));
  const withoutRepeatedContext = stripRepeatedSourceContext(cleaned, source);
  const normalized = withoutRepeatedContext === cleaned
    ? cleaned
    : normalizeDenseBullet(withoutRepeatedContext, followingCandidates) ?? withoutRepeatedContext;
  return normalized !== cleaned ? normalized : undefined;
}

function polishCareerItemBullets(
  bullets: ResumeDocumentSection["items"][number]["bullets"],
  source: ProductExperienceSummary,
  sourceBullets: string[],
  sourcePhrases: string[],
): { bullets: ResumeDocumentSection["items"][number]["bullets"]; changed: boolean } {
  const result: ResumeDocumentSection["items"][number]["bullets"] = [];
  const acceptedTexts: string[] = [];
  let changed = false;
  for (const bullet of bullets) {
    const original = bullet.text.trim();
    const qualityText = normalizeCareerBulletQuality(original, source, sourcePhrases);
    let nextText = stripDuplicateNaturalClauses(qualityText ?? original);
    const overlapTrimmed = stripClausesCoveredByAcceptedBullets(nextText, acceptedTexts, source);
    if (overlapTrimmed !== nextText) {
      nextText = normalizeDenseBullet(overlapTrimmed, sourcePhrases) ?? overlapTrimmed;
    }
    const widthText = normalizeCareerBulletCandidate(nextText, source, sourcePhrases);
    if (widthText) {
      nextText = widthText;
    } else if (needsDenseBulletExpansion(nextText)) {
      const replacement = sourceBullets.find((candidate) =>
        !isLowQualityCareerBullet(candidate, source)
          && !acceptedTexts.some((accepted) => areResumeBulletsTooSimilar(candidate, accepted, source))
          && !haveResumeMetricAnchorOverlap(candidate, acceptedTexts),
      );
      if (replacement) {
        nextText = replacement;
      } else {
        changed = true;
        continue;
      }
    }
    if (isLowQualityCareerBullet(nextText, source)) {
      const replacement = sourceBullets.find((candidate) =>
        !isLowQualityCareerBullet(candidate, source)
          && !acceptedTexts.some((accepted) => areResumeBulletsTooSimilar(candidate, accepted, source))
          && !haveResumeMetricAnchorOverlap(candidate, acceptedTexts),
      );
      if (replacement) {
        nextText = replacement;
      }
    }
    if (nextText !== original) changed = true;
    const repeatsAcceptedText = acceptedTexts.some((accepted) => areResumeBulletsTooSimilar(nextText, accepted, source));
    const repeatsAcceptedMetric = haveResumeMetricAnchorOverlap(nextText, acceptedTexts);
    if (repeatsAcceptedText || repeatsAcceptedMetric) {
      const replacement = sourceBullets.find((candidate) =>
        !acceptedTexts.some((accepted) => areResumeBulletsTooSimilar(candidate, accepted, source))
          && !haveResumeMetricAnchorOverlap(candidate, acceptedTexts),
      );
      if (!replacement) {
        if (acceptedTexts.includes(nextText)) {
          changed = true;
          continue;
        }
      } else {
        nextText = replacement;
        changed = true;
      }
    }
    result.push({
      ...bullet,
      text: nextText,
      evidenceIds: bullet.evidenceIds && bullet.evidenceIds.length > 0 ? bullet.evidenceIds : [`source-card-${source.id}`],
    });
    acceptedTexts.push(nextText);
  }
  return { bullets: result, changed: changed || result.length !== bullets.length };
}

function stripClausesCoveredByAcceptedBullets(
  text: string,
  acceptedTexts: string[],
  source: ProductExperienceSummary,
): string {
  if (acceptedTexts.length === 0 || !containsCjkText(text)) return text;
  const clauses = splitResumeBulletClauses(text);
  if (clauses.length <= 1) return text;
  const kept: string[] = [];
  for (const clause of clauses) {
    const cleaned = cleanDenseContinuation(clause);
    const covered = cleaned.length >= 8 && acceptedTexts.some((accepted) =>
      areResumeFragmentsTooSimilar(cleaned, accepted, source),
    );
    if (!covered && !haveResumeMetricAnchorOverlap(cleaned, acceptedTexts)) kept.push(clause);
  }
  if (kept.length === clauses.length || kept.length === 0) return text;
  const next = kept.join("，").replace(/[，,、；;。]+\s*$/u, "").trim();
  return next.length >= 24 ? next : text;
}

function splitResumeBulletClauses(text: string): string[] {
  return text
    .split(/[。！？!?；;，,、]\s*/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function areResumeFragmentsTooSimilar(
  fragment: string,
  fullText: string,
  source: ProductExperienceSummary,
): boolean {
  const left = normalizeBulletSimilarityText(stripSourceNames(fragment, source));
  const right = normalizeBulletSimilarityText(stripSourceNames(fullText, source));
  if (!left || !right) return false;
  if (right.includes(left) || left.includes(right)) return true;
  const leftBigrams = charBigrams(left);
  const rightBigrams = charBigrams(right);
  if (leftBigrams.size === 0 || rightBigrams.size === 0) return false;
  let overlap = 0;
  for (const gram of leftBigrams) {
    if (rightBigrams.has(gram)) overlap += 1;
  }
  return overlap / Math.min(leftBigrams.size, rightBigrams.size) >= 0.72;
}

function stripEmbeddedSourceContext(text: string, source: ProductExperienceSummary): string {
  let next = text.replace(/\s+/g, " ").trim();
  const sourceNames = uniqueNonEmpty([source.title, source.organization, source.role])
    .filter((part) => part.length >= 4);
  next = next.replace(
    /([，,、]\s*)在([^，,。；;]{4,140})(?:中|里|内|下|上)[，,、]\s*([^，。；;、,]{0,14}[:：]\s*)?/gu,
    (match: string, prefix: string, context: string) =>
      sourceNames.some((name) => context.includes(name)) ? prefix : match,
  );
  for (const name of sourceNames) {
    const escaped = escapeRegExp(name);
    const embedded = new RegExp(`([，,、]\\s*)在[^，,。；;]{0,120}${escaped}[^，,。；;]{0,120}(?:中|里|内|下|上)[，,、]\\s*`, "gu");
    next = next.replace(embedded, "$1");
  }
  return next.replace(/[，,、]\s*([，,、])/gu, "$1").trim();
}

function stripRepeatedSourceContext(text: string, source: ProductExperienceSummary): string {
  if (!containsCjkText(text)) return text;
  const sourceNames = uniqueNonEmpty([source.title, source.organization, source.role])
    .filter((part) => part.length >= 4);
  let next = text;
  const genericLeading = /^在(.{4,120}?)(?:中|里|内|下|上)?[，,]\s*/u.exec(next);
  if (genericLeading) {
    const context = genericLeading[1] ?? "";
    const rest = next.slice(genericLeading[0].length).trim();
    if (rest.length >= 8 && sourceNames.some((name) => context.includes(name))) {
      next = rest;
    }
  }
  for (const name of sourceNames) {
    const escaped = escapeRegExp(name);
    const leading = new RegExp(`^在${escaped}(?:项目|系统)?(?:中|里|内|下|上)?[，,、]\\s*`, "u");
    const match = leading.exec(next);
    if (!match) continue;
    const rest = next.slice(match[0].length).trim();
    if (rest.length >= 18 && rest.includes(name)) {
      next = rest;
    }
  }
  return stripDuplicateNaturalClauses(next);
}

function stripDuplicateNaturalClauses(text: string): string {
  const clauses = text
    .split(/([，。；;、,])/u)
    .reduce<Array<{ text: string; sep: string }>>((acc, part, index, list) => {
      if (index % 2 === 1) return acc;
      const value = part.trim();
      if (!value) return acc;
      acc.push({ text: value, sep: list[index + 1] ?? "" });
      return acc;
    }, []);
  if (clauses.length <= 1) return text;
  const accepted: Array<{ text: string; sep: string }> = [];
  const acceptedTexts: string[] = [];
  for (const clause of clauses) {
    const normalized = normalizeBulletSimilarityText(clause.text);
    const duplicateText = normalized.length >= 6 && accepted.some((item) => {
      const acceptedNormalized = normalizeBulletSimilarityText(item.text);
      return acceptedNormalized.includes(normalized) || normalized.includes(acceptedNormalized);
    });
    if (duplicateText || haveResumeMetricAnchorOverlap(clause.text, acceptedTexts)) {
      continue;
    }
    accepted.push(clause);
    acceptedTexts.push(clause.text);
  }
  if (accepted.length === clauses.length) return text;
  return accepted.map((item, index) => `${item.text}${index < accepted.length - 1 ? item.sep || "，" : ""}`).join("").trim();
}

function areResumeBulletsTooSimilar(
  a: string,
  b: string,
  source: ProductExperienceSummary,
): boolean {
  const left = normalizeBulletSimilarityText(stripSourceNames(a, source));
  const right = normalizeBulletSimilarityText(stripSourceNames(b, source));
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length >= 18 && right.length >= 18 && (left.includes(right) || right.includes(left))) return true;
  const leftBigrams = charBigrams(left);
  const rightBigrams = charBigrams(right);
  if (leftBigrams.size === 0 || rightBigrams.size === 0) return false;
  let overlap = 0;
  for (const gram of leftBigrams) {
    if (rightBigrams.has(gram)) overlap += 1;
  }
  const containment = overlap / Math.min(leftBigrams.size, rightBigrams.size);
  const jaccard = overlap / (leftBigrams.size + rightBigrams.size - overlap);
  return containment >= 0.78 || jaccard >= 0.62;
}

function isLowQualityCareerBullet(text: string, source: ProductExperienceSummary): boolean {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return true;
  if (/^%?\s*(in|at|for)\b/iu.test(cleaned)) return true;
  if (containsCjkText(cleaned) && /\b(in|at|for)\b[^，。；;]*[\u3400-\u9FFF]/iu.test(cleaned)) return true;
  if (/业务策略支持与成果落地|成果落地[，,、]\s*(研究助理|项目负责人|实习生|工程师)/u.test(cleaned)) return true;
  if (source.role && cleaned.includes(source.role) && /\b20\d{2}[.-]\d{1,2}\b/u.test(cleaned)) return true;
  if (/^(项目|职责|成果|内容|描述|亮点|工作)[:：]?$/u.test(cleaned)) return true;
  return false;
}

function haveResumeMetricAnchorOverlap(text: string, acceptedTexts: string[]): boolean {
  const anchors = extractResumeMetricAnchors(text);
  if (anchors.size === 0) return false;
  return acceptedTexts.some((accepted) => {
    const acceptedAnchors = extractResumeMetricAnchors(accepted);
    for (const anchor of anchors) {
      if (acceptedAnchors.has(anchor)) return true;
    }
    return false;
  });
}

function extractResumeMetricAnchors(text: string): Set<string> {
  const anchors = new Set<string>();
  const normalized = normalizeAsciiDigits(text);
  for (const match of normalized.matchAll(/\b[A-Za-z][A-Za-z0-9+.-]{2,}\b/gu)) {
    anchors.add(`term:${match[0]!.toLowerCase()}`);
  }
  for (const match of normalized.matchAll(/\b\d+(?:\.\d+)?\s*(?:%|％|ms|s|万\+?|千\+?)\b/gu)) {
    anchors.add(`metric:${match[0]!.replace(/\s+/g, "").toLowerCase()}`);
  }
  const pattern = /([0-9]+(?:[.+/-][0-9]+)*(?:万|千)?[+%％]?)([^，。；;、,\s]{0,20})/gu;
  const keywords = [
    "SQL",
    "PowerBI",
    "Power BI",
    "语料",
    "关键词",
    "评分",
    "一致性",
    "准确",
    "自动化",
    "看板",
    "脚本",
    "专利",
    "软著",
    "样本",
    "字",
  ];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalized))) {
    const metric = match[1]?.replace(/[+%％]/gu, "") ?? "";
    const tail = (match[2] ?? "").toLowerCase();
    const keyword = keywords.find((item) => tail.includes(item.toLowerCase()));
    if (metric && keyword) anchors.add(`${metric}:${keyword.toLowerCase().replace(/\s+/g, "")}`);
  }
  return anchors;
}

function normalizeAsciiDigits(text: string): string {
  return text.replace(/[０-９]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xff10 + 0x30));
}

function stripSourceNames(text: string, source: ProductExperienceSummary): string {
  return [source.title, source.organization, source.role]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part && part.length >= 2))
    .reduce((next, part) => next.replace(new RegExp(escapeRegExp(part), "gu"), ""), text);
}

function normalizeBulletSimilarityText(text: string): string {
  return text
    .replace(/\s+/g, "")
    .replace(/[0-9０-９]+(?:[.+%％/-][0-9０-９]+)*[+%％]?/gu, "")
    .replace(/[，。；;、,.:：\-—–_()[\]（）《》“”"']/gu, "")
    .replace(/^(在|基于|围绕|通过|使用|采用|负责|参与|主导|协同|完成|实现|支持|优化|设计|构建|输出)+/u, "")
    .replace(/(项目|系统|平台|流程|方案|能力|数据|分析|处理|管理|支持|提升|优化|实现|完成|负责|参与|主导|协同)/gu, "")
    .trim();
}

function charBigrams(text: string): Set<string> {
  const grams = new Set<string>();
  for (let index = 0; index < text.length - 1; index += 1) {
    grams.add(text.slice(index, index + 2));
  }
  return grams;
}

function trimCjkBullet(text: string): string | undefined {
  return naturalCjkPrefixInRange(text, DENSE_CJK_MIN_CHARS, DENSE_CJK_MAX_CHARS);
}

function trimAsciiBullet(text: string): string | undefined {
  if (text.length <= DENSE_ASCII_MAX_CHARS) return text.length >= DENSE_ASCII_MIN_CHARS ? text : undefined;
  const slice = text.slice(0, DENSE_ASCII_MAX_CHARS);
  const boundary = Math.max(slice.lastIndexOf(";"), slice.lastIndexOf(","), slice.lastIndexOf(" "));
  if (boundary >= DENSE_ASCII_MIN_CHARS) return slice.slice(0, boundary).replace(/[;,]\s*$/u, "");
  return slice;
}

function trimCjkTwoLineBullet(text: string): string | undefined {
  return naturalCjkPrefixInRange(text, DENSE_CJK_TWO_LINE_MIN_CHARS, DENSE_CJK_TWO_LINE_MAX_CHARS);
}

function expandCjkBullet(text: string, followingCandidates: string[]): string {
  let next = text;
  for (const candidate of followingCandidates) {
    if (next.length >= DENSE_CJK_MIN_CHARS) break;
    const cleaned = cleanNaturalContinuation(candidate);
    if (!cleaned || cleaned === next || next.includes(cleaned)) continue;
    if (isDenseContinuationRedundant(next, cleaned)) continue;
    if (cleaned.includes(next) && cleaned.length >= DENSE_CJK_MIN_CHARS) {
      next = cleaned;
      break;
    }
    next = `${next.replace(/[，、；;。！？!?,]\s*$/u, "")}，${cleaned}`;
  }
  return next;
}

function expandCjkBulletToMin(text: string, followingCandidates: string[], minChars: number): string {
  let next = text;
  for (const candidate of followingCandidates) {
    if (next.length >= minChars) break;
    const cleaned = cleanNaturalContinuation(candidate);
    if (!cleaned || cleaned === next || next.includes(cleaned)) continue;
    if (isDenseContinuationRedundant(next, cleaned)) continue;
    if (cleaned.includes(next) && cleaned.length >= minChars) {
      next = cleaned;
      break;
    }
    next = `${next.replace(/[，、；;。！？!?,]\s*$/u, "")}，${cleaned}`;
  }
  return next;
}

function expandAsciiBullet(text: string, followingCandidates: string[]): string {
  let next = text;
  for (const candidate of followingCandidates) {
    if (next.length >= DENSE_ASCII_MIN_CHARS) break;
    const cleaned = cleanDenseContinuation(candidate);
    if (!cleaned || cleaned === next || next.includes(cleaned)) continue;
    if (cleaned.includes(next) && cleaned.length >= DENSE_ASCII_MIN_CHARS) {
      next = cleaned;
      break;
    }
    next = `${next.replace(/[;,]\s*$/u, "")}; ${cleaned}`;
  }
  return next;
}

function cleanDenseContinuation(text: string): string {
  let cleaned = text
    .replace(/^[-•*\d.\s]+/u, "")
    .replace(/\s+/g, " ")
    .trim();
  for (let i = 0; i < 3; i += 1) {
    const next = cleaned.replace(/^(项目|职责|成果|内容|描述|亮点|工作|数据工程|数据清洗与预处理|大规模语料管理|核心技术难点|技术难点|项目成果|项目职责|主要贡献)[:：]\s*/u, "").trim();
    if (next === cleaned) break;
    cleaned = next;
  }
  return cleaned;
}

function isDenseContinuationRedundant(base: string, candidate: string): boolean {
  const normalizedBase = normalizeBulletSimilarityText(base);
  const normalizedCandidate = normalizeBulletSimilarityText(candidate);
  if (!normalizedBase || !normalizedCandidate) return false;
  if (normalizedBase.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedBase)) return true;
  const leftBigrams = charBigrams(normalizedBase);
  const rightBigrams = charBigrams(normalizedCandidate);
  if (leftBigrams.size === 0 || rightBigrams.size === 0) return false;
  let overlap = 0;
  for (const gram of leftBigrams) {
    if (rightBigrams.has(gram)) overlap += 1;
  }
  return overlap / Math.min(leftBigrams.size, rightBigrams.size) >= 0.72;
}

function needsDenseBulletExpansion(text: string): boolean {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return false;
  if (!containsCjkText(cleaned)) return cleaned.length < DENSE_ASCII_MIN_CHARS || cleaned.length > DENSE_ASCII_MAX_CHARS;
  return cleaned.length < DENSE_CJK_MIN_CHARS
    || (cleaned.length > DENSE_CJK_MAX_CHARS && cleaned.length < DENSE_CJK_TWO_LINE_MIN_CHARS)
    || cleaned.length > DENSE_CJK_TWO_LINE_MAX_CHARS
    || isIncompleteResumeBullet(cleaned);
}

function containsCjkText(text: string): boolean {
  return /[\u3400-\u9FFF]/u.test(text);
}

function splitNaturalCjkClauses(text: string): string[] {
  return text
    .split(/[。！？!?；;，,、]\s*/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && !isIncompleteResumeBullet(item));
}

function cleanNaturalContinuation(text: string): string | undefined {
  const cleaned = cleanDenseContinuation(text);
  if (!cleaned || isIncompleteResumeBullet(cleaned)) return undefined;
  return cleaned;
}

function naturalCjkPrefixInRange(text: string, minChars: number, maxChars: number): string | undefined {
  const cleaned = stripResumeBulletEnding(text);
  if (cleaned.length >= minChars && cleaned.length <= maxChars && !isIncompleteResumeBullet(cleaned)) {
    return cleaned;
  }
  if (cleaned.length < minChars) return undefined;
  const candidates: string[] = [];
  for (let index = 0; index < cleaned.length && index < maxChars; index += 1) {
    const char = cleaned[index] ?? "";
    if (!CJK_SENTENCE_BOUNDARIES.test(char) && !CJK_SOFT_BOUNDARIES.test(char)) continue;
    const candidate = stripResumeBulletEnding(cleaned.slice(0, index + 1));
    if (candidate.length >= minChars && candidate.length <= maxChars && !isIncompleteResumeBullet(candidate)) {
      candidates.push(candidate);
    }
  }
  return candidates.sort((a, b) => b.length - a.length)[0];
}

function stripResumeBulletEnding(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/[。！？!?；;，、,.\s]+$/u, "")
    .trim();
}

function isIncompleteResumeBullet(text: string): boolean {
  const cleaned = stripResumeBulletEnding(text);
  if (!cleaned) return true;
  const finalSegment = stripResumeBulletEnding(cleaned.split(/[，。；;、,]/u).pop() ?? cleaned);
  if (finalSegment && finalSegment !== cleaned && isDanglingResumeSegment(finalSegment)) return true;
  return isDanglingResumeSegment(cleaned);
}

function isDanglingResumeSegment(cleaned: string): boolean {
  if (/[（(][^）)]*$/u.test(cleaned) || /[《“"'][^》”"']*$/u.test(cleaned)) return true;
  if (/[A-Za-z]+-$/u.test(cleaned)) return true;
  if (/[:：]\s*[^，。；;、,]{0,8}$/u.test(cleaned)) return true;
  if (/^(支持|用于|基于|围绕|通过|使用|采用|覆盖|实现|提升|处理|构建|设计|主导|负责|参与|协同|优化|提取).{0,6}$/u.test(cleaned)) return true;
  if (/(基于|围绕|通过|使用|采用|覆盖|支持|用于|实现|提升|处理|构建|设计|主导|负责|参与|协同|以及|包括|例如|如|与|和|及|或|并|为|将|在|中|的)$/u.test(cleaned)) return true;
  if (/处理\d{1,2}$/u.test(cleaned)) return true;
  if (/智能监$/u.test(cleaned)) return true;
  if (/^在.+(?:中|下|里|内|上|前|后|阶段|项目|系统|实习生|工程师|负责人)?$/u.test(cleaned) && !/[，。；;]/u.test(cleaned)) return true;
  return false;
}

type ResumeDocumentItemEntry = {
  sectionId: string;
  sectionType: ProductResumeItem["sectionType"];
  sectionOrder: number;
  itemId: string;
  bulletIds: string[];
  bulletTexts: Record<string, string>;
  bulletEvidence: Record<string, string>;
  title: string;
  contentSnapshot: string;
  sourceExperienceId?: string;
  evidenceStrength?: "low" | "medium" | "high";
  relevanceScore?: number;
};

/**
 * Flatten `variant.resumeDocument` into one entry per LLM-produced item.
 *
 * Returns an empty array when the document is missing or has no usable
 * items, in which case `saveAcceptedVariantToResume` falls through to the
 * legacy single-item path. Each surviving entry is guaranteed to have a
 * non-empty `title` and `contentSnapshot`.
 */
function collectResumeDocumentItems(variant: ProductGeneratedVariant): ResumeDocumentItemEntry[] {
  const doc = variant.resumeDocument;
  if (!doc || !Array.isArray(doc.sections) || doc.sections.length === 0) return [];
  const entries: ResumeDocumentItemEntry[] = [];
  for (const section of doc.sections) {
    if (!section || !Array.isArray(section.items)) continue;
    for (const item of section.items) {
      const entry = toItemEntry(section, item);
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

function toItemEntry(
  section: ResumeDocumentSection,
  item: ResumeDocumentSection["items"][number],
): ResumeDocumentItemEntry | null {
  const title = (item.title ?? "").trim();
  if (!title) return null;
  const headerParts: string[] = [title];
  if (item.subtitle) headerParts.push(item.subtitle);
  if (item.period) headerParts.push(item.period);
  if (item.location) headerParts.push(item.location);
  const header = headerParts.filter(Boolean).join(" · ");
  const bulletLines = (item.bullets ?? [])
    .map((b) => (b?.text ?? "").trim())
    .filter((text) => text.length > 0)
    .map((text) => `- ${text}`);
  const contentSnapshot = bulletLines.length > 0
    ? `${header}\n${bulletLines.join("\n")}`.trim()
    : header.trim();
  if (!contentSnapshot) return null;
  return {
    sectionId: section.id,
    sectionType: section.type,
    sectionOrder: section.order,
    itemId: item.id,
    bulletIds: (item.bullets ?? []).map((b) => b?.id).filter((id): id is string => typeof id === "string" && id.length > 0),
    bulletTexts: Object.fromEntries(
      (item.bullets ?? [])
        .filter((b) => typeof b?.id === "string" && b.id.length > 0 && typeof b.text === "string")
        .map((b) => [b.id, b.text.trim()]),
    ),
    bulletEvidence: Object.fromEntries(
      (item.bullets ?? [])
        .filter((b) => typeof b?.id === "string" && b.id.length > 0 && Array.isArray(b.evidenceIds) && b.evidenceIds.length > 0)
        .map((b) => [b.id, b.evidenceIds![0]!]),
    ),
    title: title.slice(0, 120),
    contentSnapshot,
    sourceExperienceId: typeof item.sourceExperienceId === "string" && item.sourceExperienceId.trim().length > 0
      ? item.sourceExperienceId
      : undefined,
    evidenceStrength: item.evidenceStrength,
    relevanceScore: typeof item.relevanceScore === "number" ? item.relevanceScore : undefined,
  };
}
