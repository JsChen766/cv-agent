import type { ResumeExportFormat } from "../../exports/index.js";
import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { ExportResumeInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";

export function createExportAgentTools(): ToolDefinition[] {
  return [
    {
      name: "prepare_export_resume",
      description: "Preview creating a resume export.",
      ownerAgent: "architect",
      inputSchema: ExportResumeInputSchema,
      outputSchema: ToolResultSchema,
      mutability: "read",
      requiresConfirmation: false,
      riskLevel: "low",
      execute: async (input) => ({
        status: "success",
        message: "Prepared resume export for confirmation.",
        data: { resumeId: input.resumeId, format: input.format },
        actionResult: { status: "needs_confirmation", actionType: "export_resume" },
      }),
    },
    {
      name: "export_resume",
      description: "Create a resume export job.",
      ownerAgent: "architect",
      inputSchema: ExportResumeInputSchema,
      outputSchema: ToolResultSchema,
      mutability: "export",
      requiresConfirmation: true,
      riskLevel: "medium",
      execute: async (input, context) => {
        const result = await context.kernel.exportService.createExport(context.userId, {
          resumeId: String(input.resumeId),
          format: input.format as ResumeExportFormat,
          templateId: typeof input.templateId === "string" ? input.templateId : undefined,
        });
        return {
          status: "success",
          message: `Created ${String(input.format).toUpperCase()} export job.`,
          data: { exportRecord: result.exportRecord, job: result.job },
          workspacePatch: { activePanel: "resume_editor", activeExportId: result.exportRecord.id },
          actionResult: { status: "success", actionType: "export_resume", exportRecord: result.exportRecord },
        };
      },
    },
  ];
}
