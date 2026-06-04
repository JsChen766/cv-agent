import type {
  ProductExperience,
  ProductExperienceRevision,
  ProductExperienceVariant,
  ProductGeneration,
  ProductImportCandidate,
  ProductImportJob,
  ProductJDRecord,
  ProductResume,
  ProductResumeItem,
} from "../types.js";

export type ListOptions = { limit?: number };

export interface ProductExperienceRepository {
  createExperience(record: ProductExperience): Promise<ProductExperience>;
  createExperienceWithRevision(record: ProductExperience, revision: ProductExperienceRevision): Promise<{ experience: ProductExperience; revision: ProductExperienceRevision }>;
  listExperiencesByUser(userId: string, options?: ListOptions & { status?: ProductExperience["status"] }): Promise<ProductExperience[]>;
  getExperienceById(userId: string, id: string): Promise<ProductExperience | null>;
  updateExperience(userId: string, id: string, patch: Partial<ProductExperience>): Promise<ProductExperience | null>;
  archiveExperience(userId: string, id: string): Promise<ProductExperience | null>;
  createRevision(record: ProductExperienceRevision): Promise<ProductExperienceRevision>;
  listRevisionsByExperience(userId: string, experienceId: string): Promise<ProductExperienceRevision[]>;
  getRevisionById(userId: string, revisionId: string): Promise<ProductExperienceRevision | null>;
  createVariant(record: ProductExperienceVariant): Promise<ProductExperienceVariant>;
  listVariantsByExperience(userId: string, experienceId: string): Promise<ProductExperienceVariant[]>;
}

export interface ProductJDRepository {
  createJD(record: ProductJDRecord): Promise<ProductJDRecord>;
  listJDsByUser(userId: string, options?: ListOptions): Promise<ProductJDRecord[]>;
  getJDById(userId: string, id: string): Promise<ProductJDRecord | null>;
}

export interface ProductResumeRepository {
  createResume(record: ProductResume): Promise<ProductResume>;
  listResumesByUser(userId: string, options?: ListOptions): Promise<ProductResume[]>;
  getResumeById(userId: string, id: string): Promise<ProductResume | null>;
  createResumeItem(record: ProductResumeItem): Promise<ProductResumeItem>;
  listResumeItems(userId: string, resumeId: string): Promise<ProductResumeItem[]>;
  getResumeItemById(userId: string, itemId: string): Promise<ProductResumeItem | null>;
  updateResumeItem(userId: string, itemId: string, patch: Partial<ProductResumeItem>): Promise<ProductResumeItem | null>;
  reorderResumeItems(userId: string, resumeId: string, orderedIds: string[]): Promise<ProductResumeItem[]>;
  archiveResume(userId: string, resumeId: string): Promise<ProductResume | null>;
}

export interface ProductImportRepository {
  createImportJob(record: ProductImportJob): Promise<ProductImportJob>;
  getImportJob(userId: string, id: string): Promise<ProductImportJob | null>;
  updateImportJobStatus(userId: string, id: string, patch: Pick<ProductImportJob, "status"> & Partial<Pick<ProductImportJob, "errorMessage" | "updatedAt">>): Promise<ProductImportJob | null>;
  createImportCandidate(record: ProductImportCandidate): Promise<ProductImportCandidate>;
  getImportCandidate(userId: string, id: string): Promise<ProductImportCandidate | null>;
  listCandidatesByJob(userId: string, jobId: string): Promise<ProductImportCandidate[]>;
  updateCandidateStatus(userId: string, id: string, status: ProductImportCandidate["status"]): Promise<ProductImportCandidate | null>;
  acceptCandidateWithExperience?(input: {
    userId: string;
    candidateId: string;
    experience: ProductExperience;
    revision: ProductExperienceRevision;
  }): Promise<
    | { outcome: "accepted"; candidate: ProductImportCandidate; experience: ProductExperience; revision: ProductExperienceRevision }
    | { outcome: "not_pending"; candidate: ProductImportCandidate }
    | null
  >;
}

export interface ProductGenerationRepository {
  createGeneration(record: ProductGeneration): Promise<ProductGeneration>;
  getGeneration(userId: string, id: string): Promise<ProductGeneration | null>;
  listGenerationsByUser(userId: string, options?: ListOptions): Promise<ProductGeneration[]>;
  updateGenerationSelection(userId: string, id: string, selectedVariantIds: string[]): Promise<ProductGeneration | null>;
  attachResume(userId: string, id: string, resumeId: string): Promise<ProductGeneration | null>;
  saveAcceptedVariantToResume?(input: {
    userId: string;
    generationId: string;
    resume: ProductResume;
    item: ProductResumeItem;
    selectedVariantIds: string[];
  }): Promise<{ generation: ProductGeneration; resume: ProductResume; item: ProductResumeItem } | null>;
}

export class InMemoryProductExperienceRepository implements ProductExperienceRepository {
  private readonly experiences = new Map<string, ProductExperience>();
  private readonly revisions = new Map<string, ProductExperienceRevision>();
  private readonly variants = new Map<string, ProductExperienceVariant>();

  public async createExperience(record: ProductExperience): Promise<ProductExperience> {
    this.experiences.set(record.id, record);
    return record;
  }

  public async createExperienceWithRevision(record: ProductExperience, revision: ProductExperienceRevision): Promise<{ experience: ProductExperience; revision: ProductExperienceRevision }> {
    this.experiences.set(record.id, record);
    this.revisions.set(revision.id, revision);
    return { experience: record, revision };
  }

  public async listExperiencesByUser(userId: string, options: ListOptions & { status?: ProductExperience["status"] } = {}): Promise<ProductExperience[]> {
    return limit(Array.from(this.experiences.values())
      .filter((item) => item.userId === userId && (!options.status || item.status === options.status))
      .sort(descCreated), options.limit);
  }

  public async getExperienceById(userId: string, id: string): Promise<ProductExperience | null> {
    const item = this.experiences.get(id);
    return item?.userId === userId ? item : null;
  }

  public async updateExperience(userId: string, id: string, patch: Partial<ProductExperience>): Promise<ProductExperience | null> {
    const current = await this.getExperienceById(userId, id);
    if (!current) return null;
    const next = { ...current, ...patch, id: current.id, userId: current.userId };
    this.experiences.set(id, next);
    return next;
  }

  public archiveExperience(userId: string, id: string): Promise<ProductExperience | null> {
    return this.updateExperience(userId, id, { status: "archived", updatedAt: new Date().toISOString() });
  }

  public async createRevision(record: ProductExperienceRevision): Promise<ProductExperienceRevision> {
    this.revisions.set(record.id, record);
    return record;
  }

  public async listRevisionsByExperience(userId: string, experienceId: string): Promise<ProductExperienceRevision[]> {
    return Array.from(this.revisions.values())
      .filter((item) => item.userId === userId && item.experienceId === experienceId)
      .sort(descCreated);
  }

  public async getRevisionById(userId: string, revisionId: string): Promise<ProductExperienceRevision | null> {
    const item = this.revisions.get(revisionId);
    return item?.userId === userId ? item : null;
  }

  public async createVariant(record: ProductExperienceVariant): Promise<ProductExperienceVariant> {
    this.variants.set(record.id, record);
    return record;
  }

  public async listVariantsByExperience(userId: string, experienceId: string): Promise<ProductExperienceVariant[]> {
    return Array.from(this.variants.values())
      .filter((item) => item.userId === userId && item.experienceId === experienceId)
      .sort(descCreated);
  }
}

export class InMemoryProductJDRepository implements ProductJDRepository {
  private readonly jds = new Map<string, ProductJDRecord>();
  public async createJD(record: ProductJDRecord): Promise<ProductJDRecord> {
    this.jds.set(record.id, record);
    return record;
  }
  public async listJDsByUser(userId: string, options: ListOptions = {}): Promise<ProductJDRecord[]> {
    return limit(Array.from(this.jds.values()).filter((item) => item.userId === userId).sort(descCreated), options.limit);
  }
  public async getJDById(userId: string, id: string): Promise<ProductJDRecord | null> {
    const item = this.jds.get(id);
    return item?.userId === userId ? item : null;
  }
}

export class InMemoryProductResumeRepository implements ProductResumeRepository {
  private readonly resumes = new Map<string, ProductResume>();
  private readonly items = new Map<string, ProductResumeItem>();
  public async createResume(record: ProductResume): Promise<ProductResume> {
    this.resumes.set(record.id, record);
    return record;
  }
  public async listResumesByUser(userId: string, options: ListOptions = {}): Promise<ProductResume[]> {
    return limit(Array.from(this.resumes.values()).filter((item) => item.userId === userId && item.status !== "archived").sort(descCreated), options.limit);
  }
  public async getResumeById(userId: string, id: string): Promise<ProductResume | null> {
    const item = this.resumes.get(id);
    return item?.userId === userId ? item : null;
  }
  public async createResumeItem(record: ProductResumeItem): Promise<ProductResumeItem> {
    this.items.set(record.id, record);
    return record;
  }
  public async listResumeItems(userId: string, resumeId: string): Promise<ProductResumeItem[]> {
    return Array.from(this.items.values())
      .filter((item) => item.userId === userId && item.resumeId === resumeId)
      .sort((a, b) => a.orderIndex - b.orderIndex);
  }
  public async getResumeItemById(userId: string, itemId: string): Promise<ProductResumeItem | null> {
    const item = this.items.get(itemId);
    return item?.userId === userId ? item : null;
  }
  public async updateResumeItem(userId: string, itemId: string, patch: Partial<ProductResumeItem>): Promise<ProductResumeItem | null> {
    const current = await this.getResumeItemById(userId, itemId);
    if (!current) return null;
    const next = { ...current, ...patch, id: current.id, userId: current.userId, resumeId: current.resumeId };
    this.items.set(itemId, next);
    return next;
  }
  public async reorderResumeItems(userId: string, resumeId: string, orderedIds: string[]): Promise<ProductResumeItem[]> {
    for (const [index, id] of orderedIds.entries()) {
      const item = await this.getResumeItemById(userId, id);
      if (item?.resumeId === resumeId) {
        this.items.set(id, { ...item, orderIndex: index, updatedAt: new Date().toISOString() });
      }
    }
    return this.listResumeItems(userId, resumeId);
  }
  public async archiveResume(userId: string, resumeId: string): Promise<ProductResume | null> {
    const current = await this.getResumeById(userId, resumeId);
    if (!current) return null;
    const next = { ...current, status: "archived" as const, updatedAt: new Date().toISOString() };
    this.resumes.set(resumeId, next);
    return next;
  }
}

export class InMemoryProductImportRepository implements ProductImportRepository {
  private readonly jobs = new Map<string, ProductImportJob>();
  private readonly candidates = new Map<string, ProductImportCandidate>();
  public async createImportJob(record: ProductImportJob): Promise<ProductImportJob> {
    this.jobs.set(record.id, record);
    return record;
  }
  public async getImportJob(userId: string, id: string): Promise<ProductImportJob | null> {
    const item = this.jobs.get(id);
    return item?.userId === userId ? item : null;
  }
  public async updateImportJobStatus(userId: string, id: string, patch: Pick<ProductImportJob, "status"> & Partial<Pick<ProductImportJob, "errorMessage" | "updatedAt">>): Promise<ProductImportJob | null> {
    const current = await this.getImportJob(userId, id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
    this.jobs.set(id, next);
    return next;
  }
  public async createImportCandidate(record: ProductImportCandidate): Promise<ProductImportCandidate> {
    this.candidates.set(record.id, record);
    return record;
  }
  public async getImportCandidate(userId: string, id: string): Promise<ProductImportCandidate | null> {
    const item = this.candidates.get(id);
    return item?.userId === userId ? item : null;
  }
  public async listCandidatesByJob(userId: string, jobId: string): Promise<ProductImportCandidate[]> {
    return Array.from(this.candidates.values()).filter((item) => item.userId === userId && item.jobId === jobId).sort(descCreated);
  }
  public async updateCandidateStatus(userId: string, id: string, status: ProductImportCandidate["status"]): Promise<ProductImportCandidate | null> {
    const current = await this.getImportCandidate(userId, id);
    if (!current) return null;
    const next = { ...current, status, updatedAt: new Date().toISOString() };
    this.candidates.set(id, next);
    return next;
  }
}

export class InMemoryProductGenerationRepository implements ProductGenerationRepository {
  private readonly generations = new Map<string, ProductGeneration>();
  public async createGeneration(record: ProductGeneration): Promise<ProductGeneration> {
    this.generations.set(record.id, record);
    return record;
  }
  public async getGeneration(userId: string, id: string): Promise<ProductGeneration | null> {
    const item = this.generations.get(id);
    return item?.userId === userId ? item : null;
  }
  public async listGenerationsByUser(userId: string, options: ListOptions = {}): Promise<ProductGeneration[]> {
    return limit(Array.from(this.generations.values()).filter((item) => item.userId === userId).sort(descCreated), options.limit);
  }
  public async updateGenerationSelection(userId: string, id: string, selectedVariantIds: string[]): Promise<ProductGeneration | null> {
    const current = await this.getGeneration(userId, id);
    if (!current) return null;
    const next = { ...current, selectedVariantIds };
    this.generations.set(id, next);
    return next;
  }
  public async attachResume(userId: string, id: string, resumeId: string): Promise<ProductGeneration | null> {
    const current = await this.getGeneration(userId, id);
    if (!current) return null;
    const next = { ...current, resumeId };
    this.generations.set(id, next);
    return next;
  }
}

function limit<T>(items: T[], count = 50): T[] {
  return items.slice(0, Math.max(0, count));
}

function descCreated(a: { createdAt: string }, b: { createdAt: string }): number {
  return b.createdAt.localeCompare(a.createdAt);
}
