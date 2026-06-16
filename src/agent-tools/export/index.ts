import type { ResumeExportFormat } from "../../exports/index.js";
import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import type { ToolResultEntity, ToolResultNextActionHint } from "../../agent-core/tools/ToolResult.js";
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
            // Phase 1 structured fields
            resultKind: "export_not_found",
            summaryFacts: [`Export ${String(input.id)} could not be found.`],
            entities: [{ type: "export", id: String(input.id) }],
            warnings: ["The export record was not found; it may have been deleted or never created."],
          };
        }
        const ready = ["completed", "ready", "success"].includes(String(exportRecord.status || "").toLowerCase());

        // ── Phase 1 structured payload ────────────────────────────────────
        const summaryFacts: string[] = [
          `Export ${exportRecord.id} status: ${exportRecord.status}.`,
          `Format: ${exportRecord.format}.`,
          ready ? "Download is ready." : "Download is not yet ready.",
        ];
        const entities: ToolResultEntity[] = [
          {
            type: "export",
            id: exportRecord.id,
            title: `${exportRecord.format.toUpperCase()} export`,
            data: {
              status: exportRecord.status,
              resumeId: exportRecord.resumeId,
              fileId: exportRecord.fileId,
              format: exportRecord.format,
            },
          },
        ];
        const nextActionHints: ToolResultNextActionHint[] = ready
          ? [{
              type: "download_export",
              label: "Download the export",
              payload: { exportId: exportRecord.id, downloadPath: `/exports/${exportRecord.id}/download` },
            }]
          : [{
              type: "poll_export",
              label: "Check the export status again",
              payload: { exportId: exportRecord.id },
            }];
        const warnings: string[] = [];
        if (String(exportRecord.status).toLowerCase() === "failed") {
          warnings.push(`Export job failed${exportRecord.errorMessage ? `: ${exportRecord.errorMessage}` : "."}`);
        }

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
          resultKind: ready ? "export_ready" : "export_pending",
          summaryFacts,
          entities,
          ...(warnings.length > 0 ? { warnings } : {}),
          nextActionHints,
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
      execute: async (input) => {
        const format = (input.format || "html") as ResumeExportFormat;
        const resumeId = String(input.resumeId);
        return {
          status: "success",
          message: "Prepared resume export for confirmation.",
          data: { resumeId, format },
          actionResult: { status: "needs_confirmation", actionType: "export_resume" },
          // Phase 1 structured fields — surface the prepared export so the
          // Narrator can render a confirmation prompt without re-parsing.
          resultKind: "export_prepared",
          summaryFacts: [
            `Prepared a ${format.toUpperCase()} export of resume ${resumeId} for confirmation.`,
            "User must confirm before the export job is created.",
          ],
          entities: [{
            type: "resume",
            id: resumeId,
            data: { plannedFormat: format, plannedTemplateId: typeof input.templateId === "string" ? input.templateId : undefined },
          }] as ToolResultEntity[],
          nextActionHints: [{
            type: "export_resume",
            label: "Confirm and create the export job",
            payload: { resumeId, format, templateId: typeof input.templateId === "string" ? input.templateId : undefined },
          }] as ToolResultNextActionHint[],
        };
      },
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

        // ── Phase 1 structured payload ────────────────────────────────────
        const summaryFacts: string[] = [
          `Export job ${result.job.id} created for resume ${result.exportRecord.resumeId}.`,
          `Format: ${result.exportRecord.format}.`,
          `Initial status: ${result.exportRecord.status}.`,
        ];
        const entities: ToolResultEntity[] = [
          {
            type: "export",
            id: result.exportRecord.id,
            title: `${result.exportRecord.format.toUpperCase()} export`,
            data: {
              resumeId: result.exportRecord.resumeId,
              status: result.exportRecord.status,
              format: result.exportRecord.format,
            },
          },
          {
            type: "background_job",
            id: result.job.id,
            data: { type: result.job.type, status: result.job.status },
          },
        ];
        const nextActionHints: ToolResultNextActionHint[] = [
          {
            type: "get_export",
            label: "Check export status",
            payload: { id: result.exportRecord.id },
          },
        ];

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
          resultKind: "export_pending",
          summaryFacts,
          entities,
          nextActionHints,
        };
      },
    },
  ];
}
