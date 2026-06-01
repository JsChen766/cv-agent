import type { ResumeExportFormat } from "../../exports/index.js";
import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { ExportResumeInputSchema, IdInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";

export function createExportAgentTools(): ToolDefinition[] {
  return [
    {
      name: "get_export",
      description: "Get a resume export record and download status.",
      ownerAgent: "architect",
      inputSchema: IdInputSchema,
      outputSchema: ToolResultSchema,
      mutability: "read",
      requiresConfirmation: false,
      riskLevel: "low",
      execute: async (input, context) => {
        const exportRecord = await context.kernel.exportService.getExport(context.userId, String(input.id));
        if (!exportRecord) {
          return {
            status: "failed",
            message: "Export record not found.",
            visibility: "error_user_visible",
            actionResult: {
              status: "failed",
              actionType: "get_export",
              reason: "export_not_found",
            },
          };
        }
        const ready = ["completed", "ready", "success"].includes(String(exportRecord.status || "").toLowerCase());
        return {
          status: "success",
          message: ready
            ? "导出文件已生成，可以下载。"
            : `导出任务仍在处理中，当前状态：${exportRecord.status}。`,
          data: { exportRecord },
          workspacePatch: {
            activePanel: "resume_editor",
            activeExportId: exportRecord.id,
            exportRecords: [exportRecord],
          },
          actionResult: {
            status: "success",
            actionType: "get_export",
            exportRecord,
            metadata: {
              downloadPath: ready ? `/exports/${exportRecord.id}/download` : undefined,
            },
          },
          visibility: "user_summary",
        };
      },
    },
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
        const format = (input.format || "html") as ResumeExportFormat;
        const result = await context.kernel.exportService.createExport(context.userId, {
          resumeId: String(input.resumeId),
          format,
          templateId: typeof input.templateId === "string" ? input.templateId : undefined,
        });
        return {
          status: "success",
          message: "简历导出任务已创建，文件生成完成后可下载。",
          data: { exportRecord: result.exportRecord, job: result.job },
          workspacePatch: {
            activePanel: "resume_editor",
            activeExportId: result.exportRecord.id,
            exportRecords: [result.exportRecord],
          },
          actionResult: {
            status: "success",
            actionType: "export_resume",
            exportRecord: result.exportRecord,
            metadata: {
              resumeId: String(input.resumeId),
              exportId: result.exportRecord.id,
              exportStatus: result.exportRecord.status,
            },
          },
          visibility: "user_summary",
        };
      },
    },
  ];
}
