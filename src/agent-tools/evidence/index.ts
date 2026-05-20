import { z } from "zod";
import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { IdInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";

export function createEvidenceAgentTools(): ToolDefinition[] {
  return [
    {
      name: "show_evidence",
      description: "Show evidence linked to an experience or resume artifact.",
      ownerAgent: "critic",
      inputSchema: IdInputSchema,
      outputSchema: ToolResultSchema,
      mutability: "read",
      requiresConfirmation: false,
      riskLevel: "low",
      execute: async (input) => ({ status: "success", message: "Evidence loaded.", data: { id: input.id, evidence: [] } }),
    },
    {
      name: "check_unsupported_claims",
      description: "Check text for unsupported or risky claims.",
      ownerAgent: "critic",
      inputSchema: z.object({ text: z.string().optional(), resumeId: z.string().optional(), experienceId: z.string().optional() }).passthrough(),
      outputSchema: ToolResultSchema,
      mutability: "read",
      requiresConfirmation: false,
      riskLevel: "low",
      execute: async (input) => {
        const text = typeof input.text === "string" ? input.text : "";
        const warnings = /\b(best|only|guaranteed|100%|top)\b/i.test(text) ? ["Potentially exaggerated claim detected."] : [];
        return { status: "success", message: warnings.length ? "Found unsupported-claim risks." : "No obvious unsupported claims found.", data: { warnings } };
      },
    },
  ];
}
