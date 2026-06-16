import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { ResumeFileImportInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";
import { sanitizeImportCandidate } from "../../agent-core/runtime/ProductBlockPresenter.js";

export function importResumeFileAsCandidatesTool(): ToolDefinition {
  return {
    name: "import_resume_file_as_candidates",
    description: "Parse an uploaded resume file and return editable experience import candidates.",
    ownerAgent: "experience_receiver",
    inputSchema: ResumeFileImportInputSchema,
    outputSchema: ToolResultSchema,
    mutability: "read",
    requiresConfirmation: false,
    riskLevel: "low",
    execute: async (input, context) => {
      const fileId = String(input.fileId ?? "").trim();
      const originalName = typeof input.originalName === "string" ? input.originalName : undefined;
      const source = typeof input.source === "string" ? input.source : "copilot";
      if (!fileId) {
        return needsInput("fileId is required.", { fileId, originalName, source });
      }

      const file = await context.kernel.fileService.getFile(context.userId, fileId);
      if (!file) {
        return needsInput("File not found. Please upload the resume again.", { fileId, originalName, source });
      }

      let importJob: Awaited<ReturnType<typeof context.kernel.productServices.importService.createTextImportJob>> | null = null;
      try {
        const parsed = await context.kernel.fileService.getParsedDocumentByFileId(context.userId, fileId)
          ?? await context.kernel.fileService.parseFile(context.userId, fileId);
        const text = parsed.text?.trim() ?? "";
        if (!text) {
          return needsInput("The uploaded file did not contain extractable text. Please upload a text-based PDF, DOCX, or TXT file.", {
            fileId,
            originalName: originalName ?? file.originalName,
            source,
            parsedDocumentId: parsed.id,
          });
        }

        importJob = await context.kernel.productServices.importService.createTextImportJob(context.userId, parsed.text, {
          sourceType: file.mimeType === "application/pdf" ? "pdf" : "text",
        });
        const candidates = await context.kernel.productServices.importService.createCandidatesFromText(context.userId, importJob.id, {
          sourceDocumentId: parsed.id,
        });
        const safeCandidates = candidates.map((candidate) => sanitizeImportCandidate(candidate as unknown as Record<string, unknown>));
        console.debug("[import_resume_file_as_candidates] extracted candidates", {
          userId: context.userId,
          sessionId: context.sessionId,
          fileId,
          originalName: file.originalName,
          mimeType: file.mimeType,
          pageCount: parsed.metadata?.pageCount,
          textLength: parsed.text.length,
          candidateCount: candidates.length,
        });

        return {
          status: "success",
          message: `Recognized ${candidates.length} editable experience candidate(s) from ${file.originalName}.`,
          data: {
            job: importJob,
            importJobId: importJob.id,
            candidateCount: candidates.length,
            candidates: safeCandidates,
            fileId,
            originalName: originalName ?? file.originalName,
            parsedDocumentId: parsed.id,
            formSchemaVersion: 1,
            saveMode: "accept_candidate",
            actions: [
              { id: "save", type: "save_experience_candidate", label: "保存到经历库", primary: true },
              { id: "reject", type: "reject_experience_candidate", label: "忽略", primary: false },
            ],
          },
          workspacePatch: {
            activePanel: "import_candidates",
            importCandidates: safeCandidates,
            status: "awaiting_user_decision",
            summary: `Recognized ${candidates.length} resume import candidate(s).`,
          },
          actionResult: {
            status: "success",
            actionType: "import_resume_file_as_candidates",
            message: `Recognized ${candidates.length} resume import candidate(s).`,
            metadata: {
              importJobId: importJob.id,
              candidateCount: candidates.length,
              candidateIds: candidates.map((candidate) => candidate.id),
              fileId,
              parsedDocumentId: parsed.id,
            },
          },
          visibility: "user_summary",
        };
      } catch (error) {
        const latestJob = importJob ? await context.kernel.productServices.importService.getImportJob(context.userId, importJob.id) : null;
        const message = error instanceof Error ? error.message : "Experience extraction failed.";
        console.error("[import_resume_file_as_candidates] failed", {
          userId: context.userId,
          sessionId: context.sessionId,
          fileId,
          originalName: originalName ?? file.originalName,
          importJobId: importJob?.id,
          errorMessage: message,
        });
        return {
          status: "failed",
          message: `Failed to extract experiences from the uploaded resume: ${message}`,
          visibility: "error_user_visible",
          data: {
            job: latestJob ?? importJob ?? undefined,
            importJobId: importJob?.id,
            candidateCount: 0,
            candidates: [],
            fileId,
            originalName: originalName ?? file.originalName,
            formSchemaVersion: 1,
            saveMode: "accept_candidate",
          },
          actionResult: {
            status: "failed",
            actionType: "import_resume_file_as_candidates",
            reason: "resume_file_candidate_extraction_failed",
            message,
            metadata: {
              importJobId: importJob?.id,
              jobStatus: latestJob?.status,
              jobError: latestJob?.errorMessage,
              fileId,
            },
          },
        };
      }
    },
  };
}

function needsInput(message: string, metadata: Record<string, unknown>) {
  return {
    status: "needs_input" as const,
    message,
    visibility: "error_user_visible" as const,
    data: {
      candidates: [],
      candidateCount: 0,
      formSchemaVersion: 1,
      saveMode: "accept_candidate",
      ...metadata,
    },
    actionResult: {
      status: "needs_input",
      actionType: "import_resume_file_as_candidates",
      reason: "resume_file_import_needs_input",
      message,
      metadata,
    },
  };
}
