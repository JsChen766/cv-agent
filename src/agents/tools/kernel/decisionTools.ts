import { z } from "zod";
import type { ApiKernel } from "../../../api/types.js";
import type { AgentToolDefinition } from "../AgentToolTypes.js";
import { markVariantStatus } from "../helpers.js";
import { objectSchema } from "../schemas.js";

export function createDecisionTools(kernel: ApiKernel): AgentToolDefinition[] {
  return [
    {
      name: "record_variant_decision",
      description: "Record an accept/reject/prefer decision for a variant.",
      schema: z.object({
        variantId: z.string().optional(),
        decision: z.enum(["accept", "reject", "prefer", "confirm_metric"]),
        reason: z.string().optional(),
        payload: z.record(z.string(), z.unknown()).optional(),
      }),
      jsonSchema: objectSchema({ variantId: { type: "string" }, decision: { type: "string" }, reason: { type: "string" } }, ["decision"]),
      execute: async (args, context) => {
        const workspace = context.workspace;
        const variantId = args.variantId ?? context.request.clientState?.activeVariantId ?? workspace?.activeVariantId ?? workspace?.variants[0]?.id;
        const variant = workspace?.variants.find((item) => item.id === variantId);
        if (!variantId) return { status: "needs_input", assistantMessage: "请告诉我要记录哪一个版本的决定。" };
        let decisionId: string | undefined;
        try {
          const decision = await kernel.cvAgentKernel.generations.recordArtifactDecision(context.ctx, {
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
    },
    {
      name: "handle_product_action",
      description: "Safely acknowledge product actions that are completed by the frontend or product API.",
      schema: z.object({
        actionType: z.enum(["export_resume"]),
        resumeId: z.string().optional(),
        payload: z.record(z.string(), z.unknown()).optional(),
      }),
      jsonSchema: objectSchema({ actionType: { type: "string" }, resumeId: { type: "string" } }, ["actionType"]),
      execute: async (args) => {
        if (args.actionType === "export_resume") {
          return {
            status: "success",
            assistantMessage: args.resumeId
              ? "Resume export is ready to continue in the product export flow."
              : "Please choose a resume before exporting.",
            workspacePatch: args.resumeId ? { activePanel: "resume_editor", resumeId: args.resumeId } : undefined,
            rawIds: { decisionIds: args.resumeId ? [args.resumeId] : [] },
          };
        }
        return {
          status: "needs_input",
          assistantMessage: "I need a bit more information before I can do that.",
        };
      },
    },
  ];
}
