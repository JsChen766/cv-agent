import type { KernelRequestContext } from "../../kernel/context.js";
import type { GeneratedArtifact } from "../../knowledge/types.js";
import type { ProductAction, ProductTimelineItem, ProductVariant } from "../../copilot/types.js";
import type { ProductServices } from "../services/index.js";
import type {
  ProductExperienceSummary,
  ProductImportCandidateSummary,
  ProductJDSummary,
  ProductResumeDetail,
  ProductResumeSummary,
} from "../types.js";

export type ProductToolResult = {
  toolName: string;
  status: "success" | "needs_input" | "failed";
  assistantMessage: string;
  workspacePatch?: {
    activePanel?: "variants" | "experience_library" | "resume_history" | "resume_editor" | "jd_library" | "import_candidates";
    experiences?: ProductExperienceSummary[];
    jds?: ProductJDSummary[];
    resumes?: ProductResumeSummary[];
    activeResume?: ProductResumeDetail;
    importCandidates?: ProductImportCandidateSummary[];
    variants?: ProductVariant[];
    productGenerationId?: string;
    jdId?: string;
    resumeId?: string;
  };
  timelineItems?: ProductTimelineItem[];
  nextActions?: ProductAction[];
  raw?: {
    experienceIds?: string[];
    jdIds?: string[];
    resumeIds?: string[];
    generationIds?: string[];
  };
  generatedArtifacts?: GeneratedArtifact[];
};

export class ProductToolRegistry {
  public constructor(private readonly services: ProductServices) {}

  public async createExperience(userId: string, input: { title?: string; category?: string; content?: string; organization?: string; role?: string; tags?: string[] }): Promise<ProductToolResult> {
    if (!input.content || input.content.trim().length < 8) {
      return { toolName: "create_experience", status: "needs_input", assistantMessage: "请把要保存的经历内容发给我，我会加入经历库。" };
    }
    const created = await this.services.experienceService.createExperience(userId, {
      title: input.title ?? inferTitle(input.content, "新的经历"),
      category: input.category as never,
      content: input.content,
      organization: input.organization,
      role: input.role,
      tags: input.tags,
      source: "copilot",
    });
    return {
      toolName: "create_experience",
      status: "success",
      assistantMessage: `已保存到经历库：${created.experience.title}`,
      workspacePatch: { activePanel: "experience_library", experiences: await this.services.experienceService.listExperiences(userId) },
      raw: { experienceIds: [created.experience.id] },
    };
  }

  public async listExperiences(userId: string): Promise<ProductToolResult> {
    const experiences = await this.services.experienceService.listExperiences(userId);
    return {
      toolName: "list_experiences",
      status: "success",
      assistantMessage: experiences.length > 0 ? `你的经历库里有 ${experiences.length} 条经历。` : "你的经历库目前为空。可以发我一段经历并说“保存这段经历到经历库”。",
      workspacePatch: { activePanel: "experience_library", experiences },
      raw: { experienceIds: experiences.map((item) => item.id) },
    };
  }

  public async importResumeText(userId: string, rawText: string): Promise<ProductToolResult> {
    if (!rawText.trim()) {
      return { toolName: "import_resume_text", status: "needs_input", assistantMessage: "请粘贴要导入的简历文本。" };
    }
    const job = await this.services.importService.createTextImportJob(userId, rawText);
    const candidates = await this.services.importService.createCandidatesFromText(userId, job.id);
    return {
      toolName: "import_resume_text",
      status: "success",
      assistantMessage: `已从简历文本中整理出 ${candidates.length} 条候选经历，请确认后加入经历库。`,
      workspacePatch: { activePanel: "import_candidates", importCandidates: candidates },
    };
  }

  public async acceptImportCandidate(userId: string, candidateId: string): Promise<ProductToolResult> {
    const result = await this.services.importService.acceptCandidate(userId, candidateId);
    return {
      toolName: "accept_import_candidate",
      status: "success",
      assistantMessage: `已确认候选经历，并保存为：${result.experience.title}`,
      workspacePatch: { activePanel: "experience_library", experiences: await this.services.experienceService.listExperiences(userId) },
      raw: { experienceIds: [result.experience.id] },
    };
  }

  public async saveJD(userId: string, input: { rawText?: string; targetRole?: string; company?: string }): Promise<ProductToolResult> {
    if (!input.rawText?.trim()) {
      return { toolName: "save_jd", status: "needs_input", assistantMessage: "请粘贴 JD 文本。" };
    }
    const jd = await this.services.jdService.saveJD(userId, {
      rawText: input.rawText,
      targetRole: input.targetRole,
      company: input.company,
    });
    return {
      toolName: "save_jd",
      status: "success",
      assistantMessage: `已保存 JD：${jd.title}`,
      workspacePatch: { activePanel: "jd_library", jds: await this.services.jdService.listJDs(userId) },
      raw: { jdIds: [jd.id] },
    };
  }

  public async listJDs(userId: string): Promise<ProductToolResult> {
    const jds = await this.services.jdService.listJDs(userId);
    return {
      toolName: "list_jds",
      status: "success",
      assistantMessage: jds.length > 0 ? `已找到 ${jds.length} 条 JD。` : "还没有保存过 JD。",
      workspacePatch: { activePanel: "jd_library", jds },
      raw: { jdIds: jds.map((item) => item.id) },
    };
  }

  public async createResumeFromJD(ctx: KernelRequestContext, input: { sessionId?: string; jdText?: string; jdId?: string; targetRole?: string }): Promise<ProductToolResult> {
    const result = await this.services.generationProductService.generateResumeFromJD(ctx, {
      userId: ctx.user.id,
      sessionId: input.sessionId,
      jdText: input.jdText,
      jdId: input.jdId,
      targetRole: input.targetRole,
    });
    return {
      toolName: "create_resume_from_jd",
      status: "success",
      assistantMessage: `已根据 JD 生成 ${result.variants.length} 个候选版本。`,
      workspacePatch: {
        activePanel: "variants",
        productGenerationId: result.generation.id,
        jdId: result.jd.id,
      },
      raw: { generationIds: [result.generation.id], jdIds: [result.jd.id] },
      generatedArtifacts: result.variants,
    };
  }

  public async saveVariantToResume(userId: string, input: { generationId: string; variantId: string; resumeId?: string }): Promise<ProductToolResult> {
    const result = await this.services.generationProductService.saveAcceptedVariantToResume(userId, input);
    return {
      toolName: "save_variant_to_resume",
      status: "success",
      assistantMessage: "已采用该版本，并保存到当前简历草稿。",
      workspacePatch: {
        activePanel: "resume_editor",
        activeResume: { ...result.resume, items: [result.item] },
        resumeId: result.resume.id,
      },
      raw: { resumeIds: [result.resume.id], generationIds: [result.generation.id] },
    };
  }

  public async listResumes(userId: string): Promise<ProductToolResult> {
    const resumes = await this.services.resumeService.listResumes(userId);
    return {
      toolName: "list_resumes",
      status: "success",
      assistantMessage: resumes.length > 0 ? `你有 ${resumes.length} 份历史简历草稿。` : "还没有历史简历。你可以先根据 JD 生成并采用一个版本。",
      workspacePatch: { activePanel: "resume_history", resumes },
      raw: { resumeIds: resumes.map((item) => item.id) },
    };
  }

  public async openResume(userId: string, resumeId: string): Promise<ProductToolResult> {
    const resume = await this.services.resumeService.getResume(userId, resumeId);
    if (!resume) {
      return { toolName: "open_resume", status: "failed", assistantMessage: "没有找到这份简历。" };
    }
    return {
      toolName: "open_resume",
      status: "success",
      assistantMessage: `已打开简历：${resume.title}`,
      workspacePatch: { activePanel: "resume_editor", activeResume: resume, resumeId: resume.id },
      raw: { resumeIds: [resume.id] },
    };
  }
}

function inferTitle(content: string, fallback: string): string {
  return content.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim().slice(0, 80) ?? fallback;
}
