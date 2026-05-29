import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { AcceptGenerationVariantInputSchema, GenerateResumeInputSchema, IdInputSchema, ListInputSchema, ReviseResumeItemInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";
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
        return { status: "success", message: `Found ${items.length} resume(s).`, data: { count: items.length, items }, workspacePatch: { activePanel: "resume_history", resumes: items }, visibility: "internal" };
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
          ? { status: "success", message: `Loaded resume "${resume.title}".`, data: { resume }, workspacePatch: { activePanel: "resume_editor", resumeId: resume.id, activeResume: resume, active: { resumeId: resume.id } }, visibility: "internal" }
          : { status: "failed", message: "Resume not found.", data: { id: input.id }, visibility: "error_user_visible" };
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
            active: { jdId: result.jd.id, variantId: variants[0]?.id ?? undefined },
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
          visibility: "user_summary",
        };
      },
    },
    {
      name: "accept_generation_variant",
      description: "Accept a generation variant and save it to the resume.",
      ownerAgent: "architect",
      inputSchema: AcceptGenerationVariantInputSchema,
      outputSchema: ToolResultSchema,
      mutability: "write",
      requiresConfirmation: true,
      riskLevel: "medium",
      execute: async (input, context) => {
        const result = await context.kernel.productServices.generationProductService.saveAcceptedVariantToResume(context.userId, {
          generationId: String(input.generationId),
          variantId: String(input.variantId),
          resumeId: typeof input.resumeId === "string" ? input.resumeId : undefined,
        });
        // Fetch full resume detail so frontend can render the editor immediately
        let activeResume = null;
        try {
          activeResume = await context.kernel.productServices.resumeService.getResume(context.userId, result.resume.id);
        } catch {
          // Fallback: resumeId alone is enough for the frontend to fetch detail
        }
        return {
          status: "success",
          message: "已将选中的版本保存到简历。",
          data: {
            generation: result.generation,
            resume: result.resume,
            item: result.item,
            variant: result.variant,
          },
          workspacePatch: {
            activePanel: "resume_editor",
            resumeId: result.resume.id,
            activeResume: activeResume ?? result.resume,
            active: { resumeId: result.resume.id, variantId: String(input.variantId) },
            status: "accepted",
            summary: "已将选中的版本保存到简历。",
          },
          actionResult: {
            status: "success",
            actionType: "accept_generation_variant",
            variantId: String(input.variantId),
            metadata: {
              generationId: String(input.generationId),
              resumeId: result.resume.id,
            },
          },
          visibility: "user_summary",
        };
      },
    },
    {
      name: "prepare_revise_resume_item",
      description: "Preview a resume item rewrite using LLM without writing to the database.",
      ownerAgent: "architect",
      inputSchema: ReviseResumeItemInputSchema,
      outputSchema: ToolResultSchema,
      mutability: "read",
      requiresConfirmation: false,
      riskLevel: "low",
      execute: async (input, context) => {
        const itemId = String(input.resumeItemId);
        const instruction = String(input.instruction);

        // Resolve source text
        const workspace = context.workspace;
        const activeResume = workspace?.activeResume;
        const currentItem = activeResume?.items?.find((item) => item.id === itemId);
        const sourceText = currentItem?.contentSnapshot;
        if (!sourceText) {
          return {
            status: "needs_input",
            message: "找不到该简历条目的原文，请重新打开简历后再试。",
            data: { resumeItemId: itemId, instruction },
            visibility: "error_user_visible",
            actionResult: {
              status: "needs_input",
              actionType: "prepare_revise_resume_item",
              reason: "source_text_not_found",
            },
          };
        }

        // Try LLM rewrite service first
        const llmRewrite = context.kernel.llmRewriteService;
        if (llmRewrite) {
          try {
            const preview = await llmRewrite.rewriteResumeItem(sourceText, instruction);
            if (preview) {
              return {
                status: "success",
                message: "LLM generated rewrite preview for this resume item.",
                data: {
                  resumeItemId: itemId,
                  instruction,
                  sourceTextPreview: preview.sourceTextPreview,
                  rewrittenText: preview.rewrittenText,
                  changes: preview.changes,
                  warnings: preview.warnings,
                  confidence: preview.confidence,
                },
                visibility: "user_summary",
                actionResult: {
                  status: "success",
                  actionType: "prepare_revise_resume_item",
                  revisionSuggestion: {
                    kind: "resume_item" as const,
                    sourceId: itemId,
                    sourceTextPreview: preview.sourceTextPreview,
                    rewrittenText: preview.rewrittenText,
                    usedModel: true,
                  },
                  metadata: {
                    nextAction: "revise_resume_item",
                    requiresConfirmation: true,
                    usedModel: true,
                  },
                },
              };
            }
          } catch {
            // Fall through to direct model call
          }
        }

        // Fallback: use direct model client
        const modelClient = context.kernel.frontDeskModelClient;
        if (!modelClient) {
          return {
            status: "needs_input",
            message: "当前模型服务不可用，暂时无法预览改写结果。",
            data: { resumeItemId: itemId, instruction },
            visibility: "error_user_visible",
            actionResult: {
              status: "needs_input",
              actionType: "prepare_revise_resume_item",
              reason: "model_not_available",
            },
          };
        }

        const systemPrompt = [
          "You are a professional resume editor. Rewrite a single resume bullet point based on the instruction.",
          "Preserve all factual claims, metrics, and numbers. Do NOT invent new metrics or facts.",
          "Output ONLY the rewritten text. No markdown, no explanation.",
        ].join("\n");

        try {
          const response = await modelClient.chat({
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: `Original: ${sourceText}\nInstruction: ${instruction}\nRewritten:` },
            ],
            temperature: 0.3,
            maxTokens: 800,
          });

          const rewrittenText = (response.content ?? "").trim() || sourceText;
          return {
            status: "success",
            message: "Generated rewrite preview for this resume item.",
            data: { resumeItemId: itemId, sourceTextPreview: sourceText.slice(0, 200), rewrittenText },
            visibility: "user_summary",
            actionResult: {
              status: "success",
              actionType: "prepare_revise_resume_item",
              revisionSuggestion: {
                kind: "resume_item" as const,
                sourceId: itemId,
                sourceTextPreview: sourceText.slice(0, 200),
                rewrittenText,
                usedModel: true,
              },
              metadata: { nextAction: "revise_resume_item", requiresConfirmation: true, usedModel: true },
            },
          };
        } catch {
          return {
            status: "needs_input",
            message: "当前模型服务不可用，暂时无法智能改写该简历条目。",
            data: { resumeItemId: itemId, instruction },
            visibility: "error_user_visible",
            actionResult: {
              status: "needs_input",
              actionType: "prepare_revise_resume_item",
              reason: "model_call_failed",
            },
          };
        }
      },
    },
    {
      name: "revise_resume_item",
      description: "Apply a revised resume item to the database after confirmation.",
      ownerAgent: "architect",
      inputSchema: ReviseResumeItemInputSchema,
      outputSchema: ToolResultSchema,
      mutability: "write",
      requiresConfirmation: true,
      riskLevel: "medium",
      execute: async (input, context) => {
        const itemId = String(input.resumeItemId);
        const instruction = String(input.instruction);

        // Resolve the rewritten text - either from the instruction (if it contains the rewritten text)
        // or from explicit rewrittenText field
        const rewrittenText = typeof (input as Record<string, unknown>).rewrittenText === "string"
          ? String((input as Record<string, unknown>).rewrittenText).trim()
          : "";

        // Resolve source text
        const workspace = context.workspace;
        const activeResume = workspace?.activeResume;
        const currentItem = activeResume?.items?.find((item) => item.id === itemId);
        const sourceText = currentItem?.contentSnapshot;

        if (!sourceText) {
          return {
            status: "needs_input",
            message: "找不到该简历条目的原文，请重新打开简历后再试。",
            data: { resumeItemId: itemId, instruction },
            visibility: "error_user_visible",
            actionResult: {
              status: "needs_input",
              actionType: "revise_resume_item",
              reason: "source_text_not_found",
            },
          };
        }

        // If rewrittenText is provided, use it; otherwise try LLM generation as fallback
        let finalText = rewrittenText;
        let usedModel = false;

        if (!finalText) {
          const llmRewrite = context.kernel.llmRewriteService;
          if (llmRewrite) {
            try {
              const preview = await llmRewrite.rewriteResumeItem(sourceText, instruction);
              if (preview) {
                finalText = preview.rewrittenText;
                usedModel = true;
              }
            } catch {
              // ignore
            }
          }
          if (!finalText) {
            return {
              status: "needs_input",
              message: "请先预览改写结果后再确认保存。",
              data: { resumeItemId: itemId },
              visibility: "error_user_visible",
              actionResult: {
                status: "needs_input",
                actionType: "revise_resume_item",
                reason: "no_rewritten_text",
                message: "请先预览改写结果后再确认保存。",
              },
            };
          }
        }

        const resumeService = context.kernel.productServices.resumeService;
        const updated = await resumeService.updateResumeItem(context.userId, itemId, {
          contentSnapshot: finalText,
        });

        return updated
          ? {
            status: "success",
            message: "已根据你的指令优化该简历条目。",
            data: { item: updated, rewrittenText: finalText },
            workspacePatch: { activePanel: "resume_editor" },
            visibility: "user_summary",
            actionResult: {
              status: "success",
              actionType: "optimize_resume_item",
              revisionSuggestion: {
                kind: "resume_item" as const,
                sourceId: itemId,
                sourceTextPreview: sourceText.slice(0, 200),
                rewrittenText: finalText,
                usedModel,
              },
            },
          }
          : { status: "failed", message: "Resume item not found.", data: { id: itemId }, visibility: "error_user_visible" };
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
  const hasExperiences = sourceExperienceIds.length > 0;

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
        label: hasExperiences ? "已引用经历" : "待补充经历",
        tone: hasExperiences ? "neutral" : "warning",
      },
    ],
    reason: variant.reason ?? (hasExperiences
      ? "已结合 JD 与经历库素材生成，可继续核对事实和指标。"
      : "当前主要基于 JD 生成，建议补充经历库后再做精修。"),
    evidenceSummary: variant.evidenceSummary ?? {
      coverageLabel: hasExperiences
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
      level: variant.riskSummary?.level ?? (hasExperiences ? "medium" : "high"),
      unsupportedClaims: variant.riskSummary?.unsupportedClaims ?? [],
      missingEvidence: variant.riskSummary?.missingEvidence ?? (hasExperiences ? [] : ["缺少经历库素材支撑。"]),
      warnings: variant.riskSummary?.warnings ?? ["保存前请确认草稿中的事实、指标和项目边界。"],
    },
    missingInfo: variant.missingInfo ?? (hasExperiences ? ["请确认草稿中的指标是否真实可验证。"] : ["请补充工作或项目经历素材。"]),
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
