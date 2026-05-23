import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { GenerateResumeInputSchema, IdInputSchema, ListInputSchema, ReviseResumeItemInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";
import type { ProductVariant } from "../../copilot/types.js";
import type { ProductGeneratedVariant, ProductJDRecord } from "../../product/types.js";

export function createResumeAgentTools(): ToolDefinition[] {
  return [
    {
      name: "list_resumes",
      description: "List saved product resumes.",
      ownerAgent: "architect",
      inputSchema: ListInputSchema,
      outputSchema: ToolResultSchema,
      mutability: "read",
      requiresConfirmation: false,
      riskLevel: "low",
      execute: async (input, context) => {
        const items = await context.kernel.productServices.resumeService.listResumes(context.userId, typeof input.limit === "number" ? input.limit : 50);
        return { status: "success", message: `Found ${items.length} resume(s).`, data: { count: items.length, items }, workspacePatch: { activePanel: "resume_history", resumes: items } };
      },
    },
    {
      name: "get_resume",
      description: "Get a resume with items.",
      ownerAgent: "architect",
      inputSchema: IdInputSchema,
      outputSchema: ToolResultSchema,
      mutability: "read",
      requiresConfirmation: false,
      riskLevel: "low",
      execute: async (input, context) => {
        const resume = await context.kernel.productServices.resumeService.getResume(context.userId, String(input.id));
        return resume
          ? { status: "success", message: `Loaded resume "${resume.title}".`, data: { resume }, workspacePatch: { activePanel: "resume_editor", resumeId: resume.id, activeResume: resume } }
          : { status: "failed", message: "Resume not found.", data: { id: input.id } };
      },
    },
    {
      name: "generate_resume_from_jd",
      description: "Generate resume variants from a JD.",
      ownerAgent: "architect",
      inputSchema: GenerateResumeInputSchema,
      outputSchema: ToolResultSchema,
      mutability: "write",
      requiresConfirmation: true,
      riskLevel: "medium",
      execute: async (input, context) => {
        const result = await context.kernel.productServices.generationProductService.generateResumeFromJD({
          userId: context.userId,
          sessionId: context.sessionId,
          jdId: typeof input.jdId === "string" ? input.jdId : undefined,
          jdText: typeof input.jdText === "string" ? input.jdText : undefined,
          targetRole: typeof input.targetRole === "string" ? input.targetRole : undefined,
        });
        const variants = result.variants.map((variant, index) => toWorkspaceVariant(variant, result.jd, result.generation.id, index));
        return {
          status: "success",
          message: `已基于 JD 生成 ${variants.length} 个简历版本，你可以查看并选择保存到简历库。`,
          data: {
            generationId: result.generation.id,
            jd: result.jd,
            variants,
            generation: result.generation,
          },
          workspacePatch: {
            activePanel: "variants",
            productGenerationId: result.generation.id,
            jdId: result.jd.id,
            activeVariantId: variants[0]?.id ?? null,
            variants,
            status: "ready",
            summary: `已生成 ${variants.length} 个 JD 简历版本。`,
          },
          actionResult: {
            status: "success",
            actionType: "generate_resume_from_jd",
            variantId: variants[0]?.id,
            metadata: {
              generationId: result.generation.id,
              variantCount: variants.length,
            },
          },
        };
      },
    },
    {
      name: "revise_resume_item",
      description: "Revise a resume item after confirmation.",
      ownerAgent: "architect",
      inputSchema: ReviseResumeItemInputSchema,
      outputSchema: ToolResultSchema,
      mutability: "write",
      requiresConfirmation: true,
      riskLevel: "medium",
      execute: async (input, context) => {
        const itemId = String(input.resumeItemId);
        const instruction = String(input.instruction);
        // Fetch the current item to get the original contentSnapshot
        const resumeService = context.kernel.productServices.resumeService;
        // We need to find the resume that contains this item. Search through the workspace.
        const workspace = context.workspace;
        const activeResume = workspace?.activeResume;
        const currentItem = activeResume?.items?.find((item) => item.id === itemId);
        const sourceText = currentItem?.contentSnapshot ?? instruction;
        // Construct rewrittenText as a proper preview: combine original with instruction
        const rewrittenText = `${sourceText}\n\n[基于指令优化: ${instruction}]`;

        const updated = await resumeService.updateResumeItem(context.userId, itemId, {
          contentSnapshot: rewrittenText,
        });
        return updated
          ? {
            status: "success",
            message: "Updated resume item.",
            data: { item: updated },
            workspacePatch: { activePanel: "resume_editor" },
            actionResult: {
              status: "success",
              actionType: "optimize_resume_item",
              revisionSuggestion: {
                kind: "resume_item" as const,
                sourceId: itemId,
                sourceTextPreview: sourceText.slice(0, 200),
                rewrittenText,
                usedModel: false,
              },
            },
          }
          : { status: "failed", message: "Resume item not found.", data: { id: itemId } };
      },
    },
  ];
}

export function toWorkspaceVariant(
  variant: ProductGeneratedVariant,
  jd: ProductJDRecord,
  generationId: string,
  index: number,
): ProductVariant & { scores?: Record<string, number> } {
  const score = variant.scores ?? {};
  const sourceExperienceIds = variant.sourceExperienceIds ?? [];
  const sourceEvidenceIds = variant.sourceEvidenceIds ?? [];
  return {
    id: variant.id,
    artifactId: null,
    title: jd.targetRole ? `${jd.targetRole} 简历版本 ${index + 1}` : `JD 简历版本 ${index + 1}`,
    content: variant.content,
    role: index === 0 ? "recommended" : "alternative",
    status: "ready",
    score: {
      overall: score.overall,
      relevance: score.relevance,
      clarity: score.clarity,
      evidenceStrength: score.evidenceStrength,
      quantifiedImpact: score.quantifiedImpact,
    },
    badges: [
      { label: "JD 生成", tone: "positive" },
      {
        label: sourceExperienceIds.length > 0 ? "已引用经历" : "待补充经历",
        tone: sourceExperienceIds.length > 0 ? "neutral" : "warning",
      },
    ],
    reason: sourceExperienceIds.length > 0
      ? "已结合 JD 与经历库素材生成，可继续核对事实和指标。"
      : "当前主要基于 JD 生成，建议补充经历库后再做精修。",
    evidenceSummary: {
      coverageLabel: sourceExperienceIds.length > 0
        ? `已引用 ${sourceExperienceIds.length} 条经历素材。`
        : "尚未引用经历素材。",
      items: sourceExperienceIds.map((id) => ({
        id,
        title: "经历素材",
        explanation: "该经历被用于生成当前简历草稿。",
        confidence: 0.6,
      })),
    },
    riskSummary: {
      level: sourceExperienceIds.length > 0 ? "medium" : "high",
      unsupportedClaims: [],
      missingEvidence: sourceExperienceIds.length > 0 ? [] : ["缺少经历库素材支撑。"],
      warnings: ["保存前请确认草稿中的事实、指标和项目边界。"],
    },
    missingInfo: sourceExperienceIds.length > 0 ? ["请确认草稿中的指标是否真实可验证。"] : ["请补充工作或项目经历素材。"],
    sourceExperienceIds,
    sourceEvidenceIds,
    actions: [],
    raw: {
      generationId,
      jdId: jd.id,
      scores: score,
    },
    createdAt: variant.createdAt,
    after: variant.content,
    scores: score,
  };
}
