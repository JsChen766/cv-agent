import { z } from "zod";
import type { ApiKernel } from "../../api/types.js";
import type { KernelRequestContext } from "../../kernel/context.js";
import type { GeneratedArtifact } from "../../knowledge/types.js";
import type {
  CopilotChatRequest,
  CopilotSession,
  CopilotWorkspace,
  ProductAction,
  ProductTimelineItem,
  ProductVariant,
  SuggestedPrompt,
} from "../../copilot/types.js";
import { CopilotResponseBuilder } from "../../copilot/CopilotResponseBuilder.js";
import type { ProductExperienceCategory } from "../../product/types.js";
import type { RevisionInstruction } from "../../application/revision/index.js";

export type AgentToolStatus = "success" | "needs_input" | "failed";

export type AgentToolResult = {
  status: AgentToolStatus;
  assistantMessage?: string;
  workspacePatch?: Partial<CopilotWorkspace>;
  timelineItems?: ProductTimelineItem[];
  rawIds?: {
    artifactIds?: string[];
    evidenceChainIds?: string[];
    critiqueItemIds?: string[];
    decisionIds?: string[];
  };
  nextActions?: ProductAction[];
  suggestedPrompts?: SuggestedPrompt[];
};

export type AgentToolSchema = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type AgentToolExecutionContext = {
  ctx: KernelRequestContext;
  session: CopilotSession;
  workspace?: CopilotWorkspace | null;
  request: CopilotChatRequest;
  turnId: string;
};

export type AgentToolDefinition<TArgs extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: string;
  description: string;
  schema: TArgs;
  jsonSchema: Record<string, unknown>;
  execute(args: any, context: AgentToolExecutionContext): Promise<AgentToolResult>;
};

const panelEnum = z.enum(["variants", "experience_library", "resume_history", "resume_editor", "jd_library", "import_candidates"]);

export class AgentToolRegistry {
  private readonly builder = new CopilotResponseBuilder();
  private readonly tools: Map<string, AgentToolDefinition>;

  public constructor(private readonly kernel: ApiKernel) {
    const definitions: AgentToolDefinition[] = [
      this.listExperiencesTool(),
      this.createExperienceTool(),
      this.updateExperienceTool(),
      this.importResumeTextTool(),
      this.acceptImportCandidateTool(),
      this.saveJDTool(),
      this.listJDsTool(),
      this.listResumesTool(),
      this.openResumeTool(),
      this.saveVariantToResumeTool(),
      this.getDashboardTool(),
      this.getSidebarTool(),
      this.generateResumeVariantsTool(),
      this.reviseVariantTool(),
      this.showEvidenceTool(),
      this.explainChoiceTool(),
      this.recordVariantDecisionTool(),
    ];
    this.tools = new Map(definitions.map((tool) => [tool.name, tool]));
  }

  public hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  public getToolSchemas(): AgentToolSchema[] {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.jsonSchema,
    }));
  }

  public async execute(name: string, args: unknown, context: AgentToolExecutionContext): Promise<AgentToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        status: "failed",
        assistantMessage: "I cannot safely perform that operation yet.",
      };
    }
    const parsed = tool.schema.safeParse(args ?? {});
    if (!parsed.success) {
      return {
        status: "needs_input",
        assistantMessage: "I need a bit more information before I can do that.",
      };
    }
    try {
      return await tool.execute(parsed.data, context);
    } catch (error) {
      return {
        status: "failed",
        assistantMessage: error instanceof Error ? error.message : "The tool failed.",
      };
    }
  }

  private listExperiencesTool(): AgentToolDefinition {
    return {
      name: "list_experiences",
      description: "List the user's saved experience library.",
      schema: z.object({ limit: z.number().int().positive().optional() }),
      jsonSchema: objectSchema({ limit: { type: "number" } }),
      execute: async (args, context) => {
        const experiences = await this.kernel.productServices.experienceService.listExperiences(context.ctx.user.id, { limit: args.limit });
        return {
          status: "success",
          assistantMessage: experiences.length > 0 ? `找到 ${experiences.length} 条经历。` : "你的经历库目前为空，可以把一段经历发给我保存。",
          workspacePatch: { activePanel: "experience_library", experiences },
          rawIds: { decisionIds: experiences.map((item) => item.id) },
        };
      },
    };
  }

  private createExperienceTool(): AgentToolDefinition {
    const schema = z.object({
      title: z.string().optional(),
      category: z.enum(["work", "project", "education", "award", "skill", "other"]).optional(),
      content: z.string().min(8),
      organization: z.string().optional(),
      role: z.string().optional(),
      tags: z.array(z.string()).optional(),
    });
    return {
      name: "create_experience",
      description: "Save a new experience into the product experience library.",
      schema,
      jsonSchema: objectSchema({ title: { type: "string" }, category: { type: "string" }, content: { type: "string" } }, ["content"]),
      execute: async (args, context) => {
        const created = await this.kernel.productServices.experienceService.createExperience(context.ctx.user.id, {
          title: args.title ?? inferTitle(args.content, "新的经历"),
          category: args.category as ProductExperienceCategory | undefined,
          content: args.content,
          organization: args.organization,
          role: args.role,
          tags: args.tags,
          source: "copilot",
        });
        const experiences = await this.kernel.productServices.experienceService.listExperiences(context.ctx.user.id);
        return {
          status: "success",
          assistantMessage: `已保存到经历库：${created.experience.title}`,
          workspacePatch: { activePanel: "experience_library", experiences },
          rawIds: { decisionIds: [created.experience.id] },
        };
      },
    };
  }

  private updateExperienceTool(): AgentToolDefinition {
    const schema = z.object({
      experienceId: z.string().min(1),
      title: z.string().optional(),
      organization: z.string().optional(),
      role: z.string().optional(),
      tags: z.array(z.string()).optional(),
    });
    return {
      name: "update_experience",
      description: "Update metadata for an existing experience.",
      schema,
      jsonSchema: objectSchema({ experienceId: { type: "string" }, title: { type: "string" } }, ["experienceId"]),
      execute: async (args, context) => {
        const updated = await this.kernel.productServices.experienceService.updateExperience(context.ctx.user.id, args.experienceId, {
          title: args.title,
          organization: args.organization,
          role: args.role,
          ...(args.tags ? { tags: args.tags } : {}),
        });
        if (!updated) return { status: "failed", assistantMessage: "没有找到这条经历。" };
        const experiences = await this.kernel.productServices.experienceService.listExperiences(context.ctx.user.id);
        return {
          status: "success",
          assistantMessage: `已更新经历：${updated.title}`,
          workspacePatch: { activePanel: "experience_library", experiences },
          rawIds: { decisionIds: [updated.id] },
        };
      },
    };
  }

  private importResumeTextTool(): AgentToolDefinition {
    const schema = z.object({ rawText: z.string().optional() });
    return {
      name: "import_resume_text",
      description: "Import resume text and create experience candidates.",
      schema,
      jsonSchema: objectSchema({ rawText: { type: "string" } }),
      execute: async (args, context) => {
        const rawText = args.rawText ?? context.request.resumeText ?? context.request.message;
        if (!rawText.trim()) return { status: "needs_input", assistantMessage: "请粘贴要导入的简历文本。" };
        const job = await this.kernel.productServices.importService.createTextImportJob(context.ctx.user.id, rawText);
        const candidates = await this.kernel.productServices.importService.createCandidatesFromText(context.ctx.user.id, job.id);
        return {
          status: "success",
          assistantMessage: `已从简历文本中整理出 ${candidates.length} 条候选经历。`,
          workspacePatch: { activePanel: "import_candidates", importCandidates: candidates },
          rawIds: { decisionIds: [job.id, ...candidates.map((item) => item.id)] },
        };
      },
    };
  }

  private acceptImportCandidateTool(): AgentToolDefinition {
    const schema = z.object({ candidateId: z.string().min(1) });
    return {
      name: "accept_import_candidate",
      description: "Accept an imported experience candidate and save it to the library.",
      schema,
      jsonSchema: objectSchema({ candidateId: { type: "string" } }, ["candidateId"]),
      execute: async (args, context) => {
        const result = await this.kernel.productServices.importService.acceptCandidate(context.ctx.user.id, args.candidateId);
        const experiences = await this.kernel.productServices.experienceService.listExperiences(context.ctx.user.id);
        return {
          status: "success",
          assistantMessage: `已确认候选经历，并保存为：${result.experience.title}`,
          workspacePatch: { activePanel: "experience_library", experiences },
          rawIds: { decisionIds: [result.experience.id] },
        };
      },
    };
  }

  private saveJDTool(): AgentToolDefinition {
    const schema = z.object({
      rawText: z.string().optional(),
      targetRole: z.string().optional(),
      company: z.string().optional(),
    });
    return {
      name: "save_jd",
      description: "Save a job description to the user's JD library.",
      schema,
      jsonSchema: objectSchema({ rawText: { type: "string" }, targetRole: { type: "string" }, company: { type: "string" } }),
      execute: async (args, context) => {
        const rawText = args.rawText ?? context.session.jdText ?? context.request.jdText;
        if (!rawText?.trim()) return { status: "needs_input", assistantMessage: "请先粘贴 JD 文本。" };
        const jd = await this.kernel.productServices.jdService.saveJD(context.ctx.user.id, {
          rawText,
          targetRole: args.targetRole ?? context.session.targetRole ?? context.request.targetRole,
          company: args.company,
        });
        const jds = await this.kernel.productServices.jdService.listJDs(context.ctx.user.id);
        return {
          status: "success",
          assistantMessage: `已保存 JD：${jd.title}`,
          workspacePatch: { activePanel: "jd_library", jds, jdId: jd.id },
          rawIds: { decisionIds: [jd.id] },
        };
      },
    };
  }

  private listJDsTool(): AgentToolDefinition {
    return {
      name: "list_jds",
      description: "List saved job descriptions.",
      schema: z.object({ limit: z.number().int().positive().optional() }),
      jsonSchema: objectSchema({ limit: { type: "number" } }),
      execute: async (args, context) => {
        const jds = await this.kernel.productServices.jdService.listJDs(context.ctx.user.id, args.limit);
        return {
          status: "success",
          assistantMessage: jds.length > 0 ? `找到 ${jds.length} 条 JD。` : "还没有保存过 JD。",
          workspacePatch: { activePanel: "jd_library", jds },
          rawIds: { decisionIds: jds.map((item) => item.id) },
        };
      },
    };
  }

  private listResumesTool(): AgentToolDefinition {
    return {
      name: "list_resumes",
      description: "List saved resume drafts.",
      schema: z.object({ limit: z.number().int().positive().optional() }),
      jsonSchema: objectSchema({ limit: { type: "number" } }),
      execute: async (args, context) => {
        const resumes = await this.kernel.productServices.resumeService.listResumes(context.ctx.user.id, args.limit);
        return {
          status: "success",
          assistantMessage: resumes.length > 0 ? `找到 ${resumes.length} 份历史简历。` : "还没有历史简历。",
          workspacePatch: { activePanel: "resume_history", resumes },
          rawIds: { decisionIds: resumes.map((item) => item.id) },
        };
      },
    };
  }

  private openResumeTool(): AgentToolDefinition {
    const schema = z.object({ resumeId: z.string().min(1) });
    return {
      name: "open_resume",
      description: "Open a saved resume draft.",
      schema,
      jsonSchema: objectSchema({ resumeId: { type: "string" } }, ["resumeId"]),
      execute: async (args, context) => {
        const resume = await this.kernel.productServices.resumeService.getResume(context.ctx.user.id, args.resumeId);
        if (!resume) return { status: "failed", assistantMessage: "没有找到这份简历。" };
        return {
          status: "success",
          assistantMessage: `已打开简历：${resume.title}`,
          workspacePatch: { activePanel: "resume_editor", activeResume: resume, resumeId: resume.id },
          rawIds: { decisionIds: [resume.id] },
        };
      },
    };
  }

  private saveVariantToResumeTool(): AgentToolDefinition {
    const schema = z.object({
      generationId: z.string().optional(),
      variantId: z.string().optional(),
      resumeId: z.string().optional(),
    });
    return {
      name: "save_variant_to_resume",
      description: "Save a generated variant into the resume editor.",
      schema,
      jsonSchema: objectSchema({ generationId: { type: "string" }, variantId: { type: "string" }, resumeId: { type: "string" } }),
      execute: async (args, context) => {
        const generationId = args.generationId ?? context.workspace?.productGenerationId ?? undefined;
        const variantId = args.variantId ?? context.request.clientState?.activeVariantId ?? context.workspace?.activeVariantId ?? context.workspace?.variants[0]?.id;
        if (!generationId || !variantId) {
          return { status: "needs_input", assistantMessage: "请告诉我采用哪一个生成版本。" };
        }
        const result = await this.kernel.productServices.generationProductService.saveAcceptedVariantToResume(context.ctx.user.id, {
          generationId,
          variantId,
          resumeId: args.resumeId ?? context.workspace?.resumeId ?? undefined,
        });
        return {
          status: "success",
          assistantMessage: "已采用这个版本，并保存到当前简历草稿。",
          timelineItems: [{
            id: `tl-${context.turnId}-decision`,
            type: "decision_recorded",
            title: "Variant accepted",
            status: "completed",
            createdAt: new Date().toISOString(),
            relatedVariantId: variantId,
          }],
          workspacePatch: {
            activePanel: "resume_editor",
            activeResume: { ...result.resume, items: [result.item] },
            resumeId: result.resume.id,
            status: "accepted",
            variants: markVariantStatus(context.workspace?.variants ?? [], variantId, "accepted"),
          },
          rawIds: { artifactIds: [variantId], decisionIds: [result.resume.id, result.generation.id] },
        };
      },
    };
  }

  private getDashboardTool(): AgentToolDefinition {
    return {
      name: "get_dashboard",
      description: "Read the product dashboard summary.",
      schema: z.object({}),
      jsonSchema: objectSchema({}),
      execute: async (_args, context) => {
        const dashboard = await this.kernel.copilotServices.workspaceService.getDashboard(context.ctx.user.id);
        return {
          status: "success",
          assistantMessage: "已读取你的工作台概览。",
          workspacePatch: {
            activePanel: "experience_library",
            experiences: dashboard.recentExperiences,
            jds: dashboard.recentJDs,
            resumes: dashboard.recentResumes,
          },
        };
      },
    };
  }

  private getSidebarTool(): AgentToolDefinition {
    return {
      name: "get_sidebar",
      description: "Read sidebar data for recent sessions and assets.",
      schema: z.object({}),
      jsonSchema: objectSchema({}),
      execute: async (_args, context) => {
        const sidebar = await this.kernel.copilotServices.workspaceService.getSidebar(context.ctx.user.id);
        return {
          status: "success",
          assistantMessage: "已读取侧栏数据。",
          workspacePatch: {
            activePanel: "experience_library",
            experiences: sidebar.recentExperiences,
            jds: sidebar.recentJDs,
            resumes: sidebar.recentResumes,
          },
        };
      },
    };
  }

  private generateResumeVariantsTool(): AgentToolDefinition {
    const schema = z.object({
      jdText: z.string().optional(),
      jdId: z.string().optional(),
      targetRole: z.string().optional(),
    });
    return {
      name: "generate_resume_variants",
      description: "Generate tailored resume variants from a JD.",
      schema,
      jsonSchema: objectSchema({ jdText: { type: "string" }, jdId: { type: "string" }, targetRole: { type: "string" } }),
      execute: async (args, context) => {
        const jdText = args.jdText ?? context.session.jdText ?? context.request.jdText;
        if (!args.jdId && !jdText?.trim()) {
          return { status: "needs_input", assistantMessage: "请先提供 JD 文本，或选择一个历史 JD。" };
        }
        const result = await this.kernel.productServices.generationProductService.generateResumeFromJD(context.ctx, {
          userId: context.ctx.user.id,
          sessionId: context.session.id,
          jdId: args.jdId,
          jdText,
          targetRole: args.targetRole ?? context.session.targetRole ?? context.request.targetRole ?? "Target Role",
        });
        const response = this.builder.buildChatResponse({
          sessionId: context.session.id,
          turnId: context.turnId,
          userMessage: context.request.message,
          generatedArtifacts: result.variants,
          critiqueItems: result.generationResult.critiqueReport.items,
          evidenceChains: result.generationResult.evidenceChains,
          targetRole: args.targetRole ?? context.session.targetRole ?? context.request.targetRole ?? null,
          clientState: context.request.clientState ?? {},
        });
        return {
          status: "success",
          assistantMessage: response.assistantMessage.content,
          timelineItems: response.timeline,
          workspacePatch: {
            ...response.workspace,
            activePanel: "variants",
            productGenerationId: result.generation.id,
            jdId: result.jd.id,
          },
          nextActions: response.nextActions,
          rawIds: {
            artifactIds: response.raw.artifactIds,
            evidenceChainIds: response.raw.evidenceChainIds,
            critiqueItemIds: response.raw.critiqueItemIds,
            decisionIds: [result.generation.id],
          },
        };
      },
    };
  }

  private reviseVariantTool(): AgentToolDefinition {
    const schema = z.object({
      variantId: z.string().optional(),
      instruction: z.enum(["make_more_conservative", "remove_unsupported_claims", "apply_user_confirmation", "make_more_quantified", "align_to_requirement", "rewrite_for_tone", "custom"]).optional(),
      customInstruction: z.string().optional(),
    });
    return {
      name: "revise_variant",
      description: "Revise the active generated variant.",
      schema,
      jsonSchema: objectSchema({ variantId: { type: "string" }, instruction: { type: "string" }, customInstruction: { type: "string" } }),
      execute: async (args, context) => {
        const workspace = context.workspace;
        const generationId = workspace?.productGenerationId;
        const variantId = args.variantId ?? context.request.clientState?.activeVariantId ?? workspace?.activeVariantId ?? workspace?.variants[0]?.id;
        if (!generationId || !variantId) {
          return { status: "needs_input", assistantMessage: "请先选择一个要修改的生成版本。" };
        }
        const generation = await this.kernel.productServices.generationProductService.getGeneration(context.ctx.user.id, generationId);
        const artifact = findArtifact(generation?.outputSnapshot?.variants, variantId, workspace);
        if (!artifact) return { status: "failed", assistantMessage: "没有找到可修改的版本。" };
        const revised = await this.kernel.cvAgentKernel.generations.reviseArtifact(context.ctx, {
          artifact,
          instruction: args.instruction ?? inferRevisionInstruction(context.request.message),
          customInstruction: args.customInstruction,
        });
        const revisedVariant = this.builder.buildVariant({ artifact: revised.revisedArtifact, allVariants: [revised.revisedArtifact], targetRole: generation?.targetRole });
        const variants = [...(workspace?.variants ?? []), revisedVariant];
        return {
          status: "success",
          assistantMessage: "已按你的要求生成一个修改版本。",
          timelineItems: [{
            id: `tl-${context.turnId}-revision`,
            type: "revision_completed",
            title: "Revision completed",
            status: "completed",
            createdAt: new Date().toISOString(),
            relatedVariantId: revisedVariant.id,
          }],
          workspacePatch: {
            activePanel: "variants",
            variants,
            activeVariantId: revisedVariant.id,
            status: "ready",
          },
          nextActions: revisedVariant.actions,
          rawIds: { artifactIds: [revisedVariant.id] },
        };
      },
    };
  }

  private showEvidenceTool(): AgentToolDefinition {
    const schema = z.object({ variantId: z.string().optional() });
    return {
      name: "show_evidence",
      description: "Show evidence for the active generated variant.",
      schema,
      jsonSchema: objectSchema({ variantId: { type: "string" } }),
      execute: async (args, context) => {
        const workspace = ensureWorkspace(context.session.id, context.workspace);
        const variantId = args.variantId ?? context.request.clientState?.activeVariantId ?? workspace.activeVariantId ?? workspace.variants[0]?.id ?? "";
        const variant = workspace.variants.find((item) => item.id === variantId);
        const evidenceItems = variant?.evidenceSummary.items ?? [];
        const response = this.builder.buildShowEvidence({ sessionId: context.session.id, turnId: context.turnId, variantId, evidenceItems, workspace });
        return {
          status: "success",
          assistantMessage: response.assistantMessage.content,
          timelineItems: response.timeline,
          workspacePatch: response.workspace,
          rawIds: response.raw,
        };
      },
    };
  }

  private explainChoiceTool(): AgentToolDefinition {
    const schema = z.object({ variantId: z.string().optional() });
    return {
      name: "explain_choice",
      description: "Explain why the active variant is recommended.",
      schema,
      jsonSchema: objectSchema({ variantId: { type: "string" } }),
      execute: async (args, context) => {
        const workspace = ensureWorkspace(context.session.id, context.workspace);
        const variantId = args.variantId ?? context.request.clientState?.activeVariantId ?? workspace.activeVariantId ?? workspace.variants[0]?.id ?? "";
        const variant = workspace.variants.find((item) => item.id === variantId);
        const response = this.builder.buildExplainChoice({
          sessionId: context.session.id,
          turnId: context.turnId,
          variantId,
          reason: variant?.reason ?? "这个版本是基于当前 JD、经历证据和风险检查综合推荐的。",
          workspace,
        });
        return {
          status: "success",
          assistantMessage: response.assistantMessage.content,
          timelineItems: response.timeline,
          workspacePatch: response.workspace,
          rawIds: response.raw,
        };
      },
    };
  }

  private recordVariantDecisionTool(): AgentToolDefinition {
    const schema = z.object({
      variantId: z.string().optional(),
      decision: z.enum(["accept", "reject", "prefer", "confirm_metric"]),
      reason: z.string().optional(),
      payload: z.record(z.string(), z.unknown()).optional(),
    });
    return {
      name: "record_variant_decision",
      description: "Record an accept/reject/prefer decision for a variant.",
      schema,
      jsonSchema: objectSchema({ variantId: { type: "string" }, decision: { type: "string" }, reason: { type: "string" } }, ["decision"]),
      execute: async (args, context) => {
        const workspace = context.workspace;
        const variantId = args.variantId ?? context.request.clientState?.activeVariantId ?? workspace?.activeVariantId ?? workspace?.variants[0]?.id;
        const variant = workspace?.variants.find((item) => item.id === variantId);
        if (!variantId) return { status: "needs_input", assistantMessage: "请告诉我要记录哪个版本的决定。" };
        let decisionId: string | undefined;
        try {
          const decision = await this.kernel.cvAgentKernel.generations.recordArtifactDecision(context.ctx, {
            artifactId: variant?.artifactId ?? variantId,
            decision: args.decision,
            reason: args.reason ?? "User decision from Copilot.",
            sessionId: context.session.id,
            confirmation: args.payload,
          });
          decisionId = decision.id;
        } catch {
          decisionId = undefined;
        }
        const variants = markVariantStatus(workspace?.variants ?? [], variantId, args.decision === "reject" ? "rejected" : "accepted");
        return {
          status: "success",
          assistantMessage: args.decision === "reject" ? "已记录：不采用这个版本。" : "已记录你的选择。",
          timelineItems: [{
            id: `tl-${context.turnId}-decision`,
            type: "decision_recorded",
            title: "Decision recorded",
            status: "completed",
            createdAt: new Date().toISOString(),
            relatedVariantId: variantId,
          }],
          workspacePatch: { variants, activeVariantId: variantId, status: args.decision === "reject" ? "ready" : "accepted" },
          rawIds: { artifactIds: [variantId], decisionIds: decisionId ? [decisionId] : [] },
        };
      },
    };
  }
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function inferTitle(content: string, fallback: string): string {
  return content.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim().slice(0, 80) ?? fallback;
}

function ensureWorkspace(sessionId: string, workspace?: CopilotWorkspace | null): CopilotWorkspace {
  return workspace ?? {
    id: `ws-${sessionId}`,
    sessionId,
    variants: [],
    status: "empty",
    updatedAt: new Date().toISOString(),
  };
}

function markVariantStatus(variants: ProductVariant[], variantId: string, status: ProductVariant["status"]): ProductVariant[] {
  return variants.map((variant) => variant.id === variantId ? { ...variant, status } : variant);
}

function findArtifact(artifacts: GeneratedArtifact[] | undefined, variantId: string, workspace?: CopilotWorkspace | null): GeneratedArtifact | undefined {
  const workspaceVariant = workspace?.variants.find((item) => item.id === variantId);
  return artifacts?.find((item) => item.id === variantId || item.id === workspaceVariant?.artifactId);
}

function inferRevisionInstruction(message: string): RevisionInstruction {
  const lower = message.toLowerCase();
  if (lower.includes("quant") || message.includes("量化")) return "make_more_quantified";
  if (lower.includes("unsupported") || message.includes("证据")) return "remove_unsupported_claims";
  return "make_more_conservative";
}
