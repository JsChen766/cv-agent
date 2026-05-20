import type { ApiKernel } from "../api/types.js";
import type { ProductExperienceRevision, ProductResumeDetail, ProductResumeItem } from "../product/types.js";
import type { CopilotChatRequest, CopilotWorkspace, ProductVariant } from "./types.js";

const DEFAULT_PREVIEW_LIMIT = 800;
const JD_PREVIEW_LIMIT = 1_200;

export type ActiveAssetContext = {
  activeJD?: {
    id: string;
    title?: string;
    company?: string;
    targetRole?: string;
    rawTextPreview?: string;
    rawTextLength?: number;
  };
  activeResume?: {
    id: string;
    title?: string;
    targetRole?: string;
    status?: string;
    itemCount?: number;
    selectedItem?: {
      id: string;
      title?: string;
      sectionType?: string;
      contentPreview?: string;
      contentLength?: number;
    };
    itemsPreview?: Array<{
      id: string;
      title?: string;
      sectionType?: string;
      contentPreview?: string;
    }>;
  };
  activeExperience?: {
    id: string;
    title?: string;
    category?: string;
    organization?: string;
    role?: string;
    contentPreview?: string;
    contentLength?: number;
  };
  activeVariant?: {
    id: string;
    title?: string;
    role?: string;
    status?: string;
    contentPreview?: string;
  };
};

export class ActiveAssetContextBuilder {
  public constructor(private readonly kernel: Pick<ApiKernel, "productServices">) {}

  public async build(input: {
    userId: string;
    request: CopilotChatRequest;
    workspace: CopilotWorkspace | null;
  }): Promise<ActiveAssetContext> {
    const [activeJD, activeResume, activeExperience] = await Promise.all([
      this.buildActiveJD(input.userId, input.request),
      this.buildActiveResume(input.userId, input.request, input.workspace),
      this.buildActiveExperience(input.userId, input.request),
    ]);
    const activeVariant = this.buildActiveVariant(input.request, input.workspace);

    return compactContext({
      activeJD,
      activeResume,
      activeExperience,
      activeVariant,
    });
  }

  private async buildActiveJD(userId: string, request: CopilotChatRequest): Promise<ActiveAssetContext["activeJD"]> {
    const id = request.clientState?.activeJDId;
    if (!id) return undefined;
    try {
      const jd = await this.kernel.productServices.jdService.getJD(userId, id);
      if (!jd) return undefined;
      return {
        id: jd.id,
        title: jd.title,
        company: jd.company,
        targetRole: jd.targetRole,
        rawTextPreview: preview(jd.rawText, JD_PREVIEW_LIMIT),
        rawTextLength: jd.rawText.length,
      };
    } catch {
      return undefined;
    }
  }

  private async buildActiveResume(
    userId: string,
    request: CopilotChatRequest,
    workspace: CopilotWorkspace | null,
  ): Promise<ActiveAssetContext["activeResume"]> {
    const id = request.clientState?.activeResumeId ?? workspace?.resumeId ?? workspace?.activeResume?.id;
    if (!id) return undefined;
    try {
      const resume = await this.getResume(userId, id, workspace);
      if (!resume) return undefined;
      const selectedItem = request.clientState?.activeResumeItemId
        ? resume.items.find((item) => item.id === request.clientState?.activeResumeItemId)
        : undefined;
      return {
        id: resume.id,
        title: resume.title,
        targetRole: resume.targetRole,
        status: resume.status,
        itemCount: resume.items.length,
        selectedItem: selectedItem ? resumeItemContext(selectedItem, DEFAULT_PREVIEW_LIMIT) : undefined,
        itemsPreview: resume.items.slice(0, 5).map((item) => ({
          id: item.id,
          title: item.title,
          sectionType: item.sectionType,
          contentPreview: preview(item.contentSnapshot, 240),
        })),
      };
    } catch {
      return undefined;
    }
  }

  private async getResume(
    userId: string,
    id: string,
    workspace: CopilotWorkspace | null,
  ): Promise<ProductResumeDetail | null> {
    if (workspace?.activeResume?.id === id) return workspace.activeResume;
    return this.kernel.productServices.resumeService.getResume(userId, id);
  }

  private async buildActiveExperience(userId: string, request: CopilotChatRequest): Promise<ActiveAssetContext["activeExperience"]> {
    const id = request.clientState?.activeExperienceId;
    if (!id) return undefined;
    try {
      const experience = await this.kernel.productServices.experienceService.getExperience(userId, id);
      if (!experience) return undefined;
      const revision = await this.getCurrentOrLatestRevision(userId, experience.id, experience.currentRevisionId);
      return {
        id: experience.id,
        title: experience.title,
        category: experience.category,
        organization: experience.organization,
        role: experience.role,
        contentPreview: revision?.content ? preview(revision.content, DEFAULT_PREVIEW_LIMIT) : undefined,
        contentLength: revision?.content.length,
      };
    } catch {
      return undefined;
    }
  }

  private async getCurrentOrLatestRevision(
    userId: string,
    experienceId: string,
    currentRevisionId: string | undefined,
  ): Promise<ProductExperienceRevision | undefined> {
    const revisions = await this.kernel.productServices.experienceService.listRevisions(userId, experienceId);
    if (currentRevisionId) {
      const current = revisions.find((revision) => revision.id === currentRevisionId);
      if (current) return current;
    }
    return [...revisions].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  }

  private buildActiveVariant(
    request: CopilotChatRequest,
    workspace: CopilotWorkspace | null,
  ): ActiveAssetContext["activeVariant"] {
    const id = request.clientState?.activeVariantId ?? workspace?.activeVariantId;
    if (!id) return undefined;
    const variant = workspace?.variants.find((item) => item.id === id || item.artifactId === id);
    return variant ? variantContext(variant) : undefined;
  }
}

function compactContext(context: ActiveAssetContext): ActiveAssetContext {
  return Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined)) as ActiveAssetContext;
}

function resumeItemContext(item: ProductResumeItem, limit: number): NonNullable<NonNullable<ActiveAssetContext["activeResume"]>["selectedItem"]> {
  return {
    id: item.id,
    title: item.title,
    sectionType: item.sectionType,
    contentPreview: preview(item.contentSnapshot, limit),
    contentLength: item.contentSnapshot.length,
  };
}

function variantContext(variant: ProductVariant): NonNullable<ActiveAssetContext["activeVariant"]> {
  return {
    id: variant.id,
    title: variant.title,
    role: variant.role,
    status: variant.status,
    contentPreview: preview(variant.content, DEFAULT_PREVIEW_LIMIT),
  };
}

function preview(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}
