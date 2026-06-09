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
} from "../types.js";
import { extractExperienceDraftFromText } from "../experienceDraft.js";
import type { LLMExperienceExtractor } from "../LLMExperienceExtractor.js";
import { extractedCandidateToDraft } from "../LLMExperienceExtractor.js";
import { LLMGenerationError, type LLMGenerationService } from "../LLMGenerationService.js";
import type { EvidenceRAGService, EvidencePack, ClaimGraphIndexer } from "../../rag/evidence/index.js";
import { isDeterministicFallbackAllowed } from "../deterministicFallbackGuard.js";
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
  evidenceRAGService?: EvidenceRAGService;
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
    if (updatedExperience) await this.indexExperienceBestEffort(userId, updatedExperience, revision);
    return revision;
  }

  public async indexExperienceBestEffort(userId: string, experience: ProductExperience, revision: ProductExperienceRevision): Promise<void> {
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

  public createTextImportJob(userId: string, rawText: string): Promise<ProductImportJob> {
    const now = new Date().toISOString();
    return this.repository.createImportJob({
      id: `pimp-${randomUUID()}`,
      userId,
      sourceType: "text",
      status: "pending",
      rawText,
      createdAt: now,
      updatedAt: now,
    });
  }

  public async createCandidatesFromText(userId: string, jobId: string): Promise<ProductImportCandidate[]> {
    const job = await this.repository.getImportJob(userId, jobId);
    if (!job) throw new Error("Import job not found.");
    await this.repository.updateImportJobStatus(userId, jobId, { status: "extracting" });

    const rawText = job.rawText ?? "";
    const candidates: ProductImportCandidate[] = [];

    // Primary path: LLM extraction
    if (this.llmExtractor) {
      const extracted = await this.llmExtractor.extractCandidates(rawText);
      if (extracted.length > 0) {
        for (const candidate of extracted) {
          const draft = extractedCandidateToDraft(candidate);
          const now = new Date().toISOString();
          candidates.push(await this.repository.createImportCandidate({
            id: `pimpcand-${randomUUID()}`,
            jobId,
            userId,
            title: draft.title,
            category: draft.category,
            organization: draft.organization,
            role: draft.role,
            startDate: draft.startDate,
            endDate: draft.endDate,
            content: draft.content,
            structured: draft.structured,
            status: "pending",
            createdAt: now,
            updatedAt: now,
          }));
        }
        await this.repository.updateImportJobStatus(userId, jobId, { status: "candidates_ready" });
        return candidates;
      }
      // LLM returned no candidates — only fall back in test mode
      if (!isDeterministicFallbackAllowed()) {
        await this.repository.updateImportJobStatus(userId, jobId, { status: "failed", errorMessage: "LLM extraction returned no candidates." });
        throw new Error("LLM_PROVIDER_NOT_CONFIGURED: The AI model could not extract any experiences from the provided text. Please try with more structured content.");
      }
    } else if (!isDeterministicFallbackAllowed()) {
      await this.repository.updateImportJobStatus(userId, jobId, { status: "failed", errorMessage: "No LLM provider configured for experience extraction." });
      throw new Error("LLM_PROVIDER_NOT_CONFIGURED: No AI model provider is configured. Set DEEPSEEK_API_KEY or AGENT_API_KEY to enable intelligent experience extraction.");
    }

    // Deterministic fallback: rule-based chunking and extraction (test mode only)
    const chunks = splitExperienceText(rawText);
    for (const [index, content] of chunks.entries()) {
      const draft = extractExperienceDraftFromText(content);
      const now = new Date().toISOString();
      candidates.push(await this.repository.createImportCandidate({
        id: `pimpcand-${randomUUID()}`,
        jobId,
        userId,
        title: draft.title || inferTitle(content, `Imported experience ${index + 1}`),
        category: draft.category,
        organization: draft.organization,
        role: draft.role,
        startDate: draft.startDate,
        endDate: draft.endDate,
        content: draft.content,
        structured: draft.structured,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      }));
    }
    await this.repository.updateImportJobStatus(userId, jobId, { status: "candidates_ready" });
    return candidates;
  }

  public getImportJob(userId: string, id: string): Promise<ProductImportJob | null> {
    return this.repository.getImportJob(userId, id);
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

  private async indexAcceptedExperienceBestEffort(userId: string, experience: ProductExperience, revision: ProductExperienceRevision): Promise<void> {
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
  public constructor(
    private readonly repository: ProductGenerationRepository,
    private readonly jdService: JDService,
    private readonly resumeService: ResumeService,
    private readonly experienceService: ExperienceService,
    private readonly llmGenerationService?: LLMGenerationService,
    private readonly evidenceRAGService?: EvidenceRAGService,
  ) {}

  public async generateResumeFromJD(input: {
    userId: string;
    sessionId?: string;
    jdId?: string;
    jdText?: string;
    targetRole?: string;
  }): Promise<{ generation: ProductGeneration; jd: ProductJDRecord; variants: ProductGeneratedVariant[] }> {
    if (!input.jdId && !input.jdText?.trim()) {
      throw new Error("JD text or jdId is required.");
    }
    const jd = input.jdId
      ? await this.jdService.getJD(input.userId, input.jdId)
      : await this.jdService.saveJD(input.userId, {
          rawText: input.jdText ?? "",
          targetRole: input.targetRole,
        });
    if (!jd) throw new Error("JD not found.");
    const targetRole = input.targetRole ?? jd.targetRole;
    const evidencePack = this.evidenceRAGService
      ? await this.evidenceRAGService.buildEvidencePack({
          userId: input.userId,
          jdText: jd.rawText,
          targetRole,
          limit: 12,
        })
      : undefined;
    const experiences = evidencePack
      ? await this.experienceService.listExperiences(input.userId, {
          limit: 100,
          status: "active",
        }).then((items) => filterExperiencesByEvidencePack(items, evidencePack).slice(0, 12))
      : await this.experienceService.listExperiences(input.userId, { limit: 10, status: "active" });

    let variants: ProductGeneratedVariant[];
    if (this.llmGenerationService) {
      try {
        variants = evidencePack
          ? await this.llmGenerationService.generateVariantsWithEvidenceContext({
              userId: input.userId,
              jdText: jd.rawText,
              targetRole,
              evidencePack,
            })
          : await this.llmGenerationService.generateVariants(
              input.userId,
              jd.rawText,
              targetRole,
              experiences,
            );
        if (evidencePack && this.evidenceRAGService) {
          variants = this.evidenceRAGService.verifyGeneratedVariants(variants, evidencePack);
        }
      } catch (error) {
        throw generationFailureError(error);
      }
      if (variants.length === 0) {
        throw new Error("LLM_GENERATION_FAILED: The AI model call completed but no valid resume variants were produced.");
      }
    } else if (!isDeterministicFallbackAllowed()) {
      throw new Error("LLM_PROVIDER_NOT_CONFIGURED: No AI model provider is configured. Set DEEPSEEK_API_KEY or AGENT_API_KEY to enable intelligent resume generation.");
    } else {
      // No LLM service available, use template fallback (test mode only)
      variants = buildDraftVariants(input.userId, jd.rawText, targetRole, experiences);
      if (evidencePack && this.evidenceRAGService) {
        variants = this.evidenceRAGService.verifyGeneratedVariants(variants, evidencePack);
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
        ...(evidencePack ? { evidencePack } : {}),
      },
      outputSnapshot: {
        variants,
      },
      selectedVariantIds: [],
      createdAt: new Date().toISOString(),
    };
    await this.repository.createGeneration(generation);
    return { generation, jd, variants };
  }

  public async saveAcceptedVariantToResume(userId: string, input: {
    generationId: string;
    variantId: string;
    resumeId?: string;
  }): Promise<{ generation: ProductGeneration; resume: ProductResume; item: ProductResumeItem; variant: ProductGeneratedVariant }> {
    const generation = await this.repository.getGeneration(userId, input.generationId);
    if (!generation) throw new Error("Generation not found.");
    const variants = generation.outputSnapshot?.variants ?? [];
    const variant = variants.find((item) => item.id === input.variantId);
    if (!variant) throw new Error("Variant not found in generation.");
    const resume = input.resumeId
      ? await this.resumeService.getResume(userId, input.resumeId)
      : null;
    const targetResume = resume
      ? resumeToRecord(resume)
      : buildResumeRecord(userId, {
      targetRole: generation.targetRole,
      jdId: generation.jdId,
      title: generation.targetRole ? `${generation.targetRole} draft` : "Copilot resume draft",
    });
    const item = buildResumeItemRecord(userId, targetResume.id, {
      sourceArtifactId: variant.id,
      sectionType: "experience",
      title: inferTitle(variant.content, "Accepted variant"),
      contentSnapshot: variant.content,
      orderIndex: resume?.items.length ?? 0,
      metadata: { generationId: generation.id },
    });
    const selected = Array.from(new Set([...generation.selectedVariantIds, variant.id]));
    if (this.repository.saveAcceptedVariantToResume) {
      const saved = await this.repository.saveAcceptedVariantToResume({
        userId,
        generationId: generation.id,
        resume: targetResume,
        item,
        selectedVariantIds: selected,
      });
      if (saved) return { ...saved, variant };
    }
    const savedResume = resume ? targetResume : await this.resumeService.createResume(userId, {
      targetRole: generation.targetRole,
      jdId: generation.jdId,
      title: targetResume.title,
    });
    const savedItem = await this.resumeService.addResumeItem(userId, savedResume.id, {
      sourceArtifactId: variant.id,
      sectionType: item.sectionType,
      title: item.title,
      contentSnapshot: item.contentSnapshot,
      metadata: item.metadata,
    });
    await this.repository.updateGenerationSelection(userId, generation.id, selected);
    const attached = await this.repository.attachResume(userId, generation.id, savedResume.id);
    return { generation: attached ?? generation, resume: savedResume, item: savedItem, variant };
  }

  public getGeneration(userId: string, id: string): Promise<ProductGeneration | null> {
    return this.repository.getGeneration(userId, id);
  }

  public listGenerations(userId: string, limit?: number): Promise<ProductGeneration[]> {
    return this.repository.listGenerationsByUser(userId, { limit });
  }
}

function filterExperiencesByEvidencePack<T extends ProductExperienceSummary>(experiences: T[], evidencePack: EvidencePack): T[] {
  const rankedIds = evidencePack.retrievalTrace.map((item) => item.experienceId);
  const rank = new Map(rankedIds.map((id, index) => [id, index]));
  return experiences
    .filter((item) => rank.has(item.id))
    .sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
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

function optional(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function nonEmpty(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function splitExperienceText(rawText: string): string[] {
  const chunks = rawText
    .split(/\n\s*\n|(?:\r?\n)?[-*]\s+/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
  return chunks.length > 0 ? chunks.slice(0, 8) : [rawText.trim()].filter(Boolean);
}

function inferTitle(content: string, fallback: string): string {
  const firstLine = content.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
  return (firstLine ?? fallback).replace(/^[-*]\s*/, "").slice(0, 80);
}
