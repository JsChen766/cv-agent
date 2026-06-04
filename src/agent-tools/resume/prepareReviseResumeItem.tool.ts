import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { ReviseResumeItemInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";
import { PREPARE_REVISE_RESUME_ITEM_SYSTEM_PROMPT } from "./prompts.js";

export function createPrepareReviseResumeItemTool(): ToolDefinition {
  return {
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
                  changes: preview.changes ?? [],
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

      try {
        const response = await modelClient.chat({
          messages: [
            { role: "system", content: PREPARE_REVISE_RESUME_ITEM_SYSTEM_PROMPT },
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
              changes: [],
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
  };
}
