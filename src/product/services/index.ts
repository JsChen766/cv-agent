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
};

export class ExperienceService {
  public constructor(private readonly repository: ProductExperienceRepository) {}

  public async createExperience(userId: string, input: {
    title: string;
    category?: ProductExperienceCategory;
    content: string;
    organization?: string;
    role?: string;
    tags?: string[];
    source?: ProductExperienceRevision["source"];
  }): Promise<{ experience: ProductExperience; revision: ProductExperienceRevision }> {
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
      source: input.source ?? "manual",
      createdAt: now,
    };
    return this.repository.createExperienceWithRevision(experience, revision);
  }

  public async listExperiences(userId: string, filters: { limit?: number; status?: ProductExperience["status"] } = {}): Promise<Array<ProductExperience & { content?: string }>> {
    const experiences = await this.repository.listExperiencesByUser(userId, { limit: filters.limit, status: filters.status ?? "active" });
    return Promise.all(experiences.map(async (experience) => {
      const revision = experience.currentRevisionId
        ? await this.repository.getRevisionById(userId, experience.currentRevisionId)
        : null;
      return { ...experience, content: revision?.content };
    }));
  }

  public getExperience(userId: string, id: string): Promise<ProductExperience | null> {
    return this.repository.getExperienceById(userId, id);
  }

  public async updateExperience(userId: string, id: string, patch: Partial<ProductExperience>): Promise<ProductExperience | null> {
    return this.repository.updateExperience(userId, id, { ...patch, updatedAt: new Date().toISOString() });
  }

  public archiveExperience(userId: string, id: string): Promise<ProductExperience | null> {
    return this.repository.archiveExperience(userId, id);
  }

  public async createRevision(userId: string, experienceId: string, input: {
    content: string;
    structured?: unknown;
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
    await this.repository.updateExperience(userId, experienceId, {
      currentRevisionId: revision.id,
      updatedAt: new Date().toISOString(),
    });
    return revision;
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
  public constructor(
    private readonly repository: ProductImportRepository,
    private readonly experienceService: ExperienceService,
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
    const chunks = splitExperienceText(job.rawText ?? "");
    const candidates: ProductImportCandidate[] = [];
    for (const [index, content] of chunks.entries()) {
      const now = new Date().toISOString();
      candidates.push(await this.repository.createImportCandidate({
        id: `pimpcand-${randomUUID()}`,
        jobId,
        userId,
        title: inferTitle(content, `Imported experience ${index + 1}`),
        category: inferCategory(content),
        content,
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

  public async acceptCandidate(userId: string, candidateId: string): Promise<{ candidate: ProductImportCandidate; experience: ProductExperience }> {
    const candidate = await this.repository.getImportCandidate(userId, candidateId);
    if (!candidate) throw new Error("Import candidate not found.");
    const { experience } = await this.experienceService.createExperience(userId, {
      title: candidate.title,
      category: candidate.category,
      content: candidate.content,
      organization: candidate.organization,
      role: candidate.role,
      source: "import",
    });
    const updated = await this.repository.updateCandidateStatus(userId, candidateId, "accepted");
    return { candidate: updated ?? candidate, experience };
  }

  public async rejectCandidate(userId: string, candidateId: string): Promise<ProductImportCandidate> {
    const candidate = await this.repository.updateCandidateStatus(userId, candidateId, "rejected");
    if (!candidate) throw new Error("Import candidate not found.");
    return candidate;
  }
}

export class GenerationProductService {
  public constructor(
    private readonly repository: ProductGenerationRepository,
    private readonly jdService: JDService,
    private readonly resumeService: ResumeService,
    private readonly experienceService: ExperienceService,
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
    const experiences = await this.experienceService.listExperiences(input.userId, { limit: 6, status: "active" });
    const variants = buildDraftVariants(input.userId, jd.rawText, input.targetRole ?? jd.targetRole, experiences);
    const generation: ProductGeneration = {
      id: `pgen-${randomUUID()}`,
      userId: input.userId,
      sessionId: input.sessionId,
      jdId: jd.id,
      targetRole: input.targetRole ?? jd.targetRole,
      inputSnapshot: {
        jdId: jd.id,
        targetRole: input.targetRole ?? jd.targetRole,
        sourceExperienceIds: experiences.map((item) => item.id),
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
    const targetResume = resume ?? await this.resumeService.createResume(userId, {
      targetRole: generation.targetRole,
      jdId: generation.jdId,
      title: generation.targetRole ? `${generation.targetRole} draft` : "Copilot resume draft",
    });
    const item = await this.resumeService.addResumeItem(userId, targetResume.id, {
      sourceArtifactId: variant.id,
      sectionType: "experience",
      title: inferTitle(variant.content, "Accepted variant"),
      contentSnapshot: variant.content,
      metadata: { generationId: generation.id },
    });
    const selected = Array.from(new Set([...generation.selectedVariantIds, variant.id]));
    // TODO(P10): move resume creation, item creation, and generation attachment into a
    // product unit-of-work when product repositories share a transaction runner.
    await this.repository.updateGenerationSelection(userId, generation.id, selected);
    const attached = await this.repository.attachResume(userId, generation.id, targetResume.id);
    return { generation: attached ?? generation, resume: targetResume, item, variant };
  }

  public getGeneration(userId: string, id: string): Promise<ProductGeneration | null> {
    return this.repository.getGeneration(userId, id);
  }

  public listGenerations(userId: string, limit?: number): Promise<ProductGeneration[]> {
    return this.repository.listGenerationsByUser(userId, { limit });
  }
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

function inferCategory(content: string): ProductExperienceCategory {
  const lower = content.toLowerCase();
  if (lower.includes("university") || lower.includes("education")) return "education";
  if (lower.includes("award")) return "award";
  if (lower.includes("skill")) return "skill";
  if (lower.includes("project")) return "project";
  return "work";
}
