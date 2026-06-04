import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { ReviseResumeItemInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";

export function createReviseResumeItemTool(): ToolDefinition {
  return {
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

      if (!rewrittenText) {
        return {
          status: "needs_input",
          message: "Please preview the rewrite before confirming.",
          data: { resumeItemId: itemId },
          visibility: "error_user_visible",
          actionResult: {
            status: "needs_input",
            actionType: "revise_resume_item",
            reason: "no_rewritten_text",
            message: "Please preview the rewrite before confirming.",
          },
        };
      }

      // If rewrittenText is provided, use it; otherwise try LLM generation as fallback
      let finalText = rewrittenText;
      let usedModel = true;

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
              changes: [],
            },
          },
        }
        : { status: "failed", message: "Resume item not found.", data: { id: itemId }, visibility: "error_user_visible" };
    },
  };
}
