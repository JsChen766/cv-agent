import { z } from "zod";
import { CopilotResponseBuilder } from "../../../copilot/CopilotResponseBuilder.js";
import type { AgentToolDefinition } from "../AgentToolTypes.js";
import { ensureWorkspace } from "../helpers.js";
import { objectSchema } from "../schemas.js";

export function createEvidenceTools(): AgentToolDefinition[] {
  const builder = new CopilotResponseBuilder();
  return [
    {
      name: "show_evidence",
      description: "Show evidence for the active generated variant.",
      schema: z.object({ variantId: z.string().optional() }),
      jsonSchema: objectSchema({ variantId: { type: "string" } }),
      execute: async (args, context) => {
        const workspace = ensureWorkspace(context.session.id, context.workspace);
        const variantId = args.variantId ?? context.request.clientState?.activeVariantId ?? workspace.activeVariantId ?? workspace.variants[0]?.id ?? "";
        const variant = workspace.variants.find((item) => item.id === variantId);
        const evidenceItems = variant?.evidenceSummary.items ?? [];
        const response = builder.buildShowEvidence({ sessionId: context.session.id, turnId: context.turnId, variantId, evidenceItems, workspace });
        return {
          status: "success",
          assistantMessage: response.assistantMessage.content,
          timelineItems: response.timeline,
          workspacePatch: response.workspace,
          rawIds: response.raw,
        };
      },
    },
    {
      name: "explain_choice",
      description: "Explain why the active variant is recommended.",
      schema: z.object({ variantId: z.string().optional() }),
      jsonSchema: objectSchema({ variantId: { type: "string" } }),
      execute: async (args, context) => {
        const workspace = ensureWorkspace(context.session.id, context.workspace);
        const variantId = args.variantId ?? context.request.clientState?.activeVariantId ?? workspace.activeVariantId ?? workspace.variants[0]?.id ?? "";
        const variant = workspace.variants.find((item) => item.id === variantId);
        const response = builder.buildExplainChoice({
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
    },
  ];
}
