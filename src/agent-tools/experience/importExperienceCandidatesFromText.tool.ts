import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { TextInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";
import { sanitizeImportCandidate } from "../../agent-core/runtime/ProductBlockPresenter.js";

export function importExperienceCandidatesFromTextTool(): ToolDefinition {
  return {
    name: "import_experience_candidates_from_text",
    description: "Recognize editable experience import candidates from free text without saving them to the experience library.",
    ownerAgent: "experience_receiver",
    inputSchema: TextInputSchema,
    outputSchema: ToolResultSchema,
    mutability: "read",
    requiresConfirmation: false,
    riskLevel: "low",
    execute: async (input, context) => {
      const text = String(input.text);
      let job: Awaited<ReturnType<typeof context.kernel.productServices.importService.createTextImportJob>> | null = null;

      try {
        job = await context.kernel.productServices.importService.createTextImportJob(context.userId, text);
        const candidates = await context.kernel.productServices.importService.createCandidatesFromText(context.userId, job.id);
        const safeCandidates = candidates.map((candidate) => sanitizeImportCandidate(candidate as unknown as Record<string, unknown>));

        return {
          status: "success",
          message: candidates.length > 0
            ? `已识别出 ${candidates.length} 条候选经历，等待你确认保存。`
            : "未识别出可导入的经历候选。",
          data: {
            job,
            candidates: safeCandidates,
            formSchemaVersion: 1,
            saveMode: "accept_candidate",
            actions: [
              { id: "save", type: "save_experience_candidate", label: "保存到经历库" },
              { id: "reject", type: "reject_experience_candidate", label: "忽略" },
            ],
          },
          actionResult: {
            status: "success",
            actionType: "import_experience_candidates_from_text",
            message: candidates.length > 0
              ? `Recognized ${candidates.length} experience candidate(s).`
              : "No experience candidates were recognized.",
            metadata: {
              jobId: job.id,
              candidateIds: candidates.map((candidate) => candidate.id),
            },
          },
        };
      } catch (error) {
        const latestJob = job ? await context.kernel.productServices.importService.getImportJob(context.userId, job.id) : null;
        const reason = importFailureReason(error);
        const status = reason === "candidate_extraction_failed" ? "failed" : "needs_input";
        const message = status === "needs_input"
          ? "暂时无法从这段文本自动识别出可编辑候选。请补充论文/项目标题、你的角色和一两句事实描述后再试。"
          : "导入候选经历时遇到内部错误，请稍后重试。";

        console.error("[import_experience_candidates_from_text] candidate extraction failed", {
          userId: context.userId,
          sessionId: context.sessionId,
          jobId: job?.id,
          reason,
          errorMessage: error instanceof Error ? error.message : String(error),
        });

        return {
          status,
          message,
          visibility: "error_user_visible",
          data: {
            job: latestJob ?? job ?? undefined,
            candidates: [],
            formSchemaVersion: 1,
            saveMode: "accept_candidate",
            error: latestJob?.errorMessage,
          },
          actionResult: {
            status,
            actionType: "import_experience_candidates_from_text",
            reason,
            message,
            jobId: job?.id,
            metadata: {
              jobId: job?.id,
              jobStatus: latestJob?.status,
              jobError: latestJob?.errorMessage,
            },
          },
        };
      }
    },
  };
}

function importFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/could not extract|returned no candidates|no candidates/i.test(message)) return "no_candidates_recognized";
  if (/LLM_PROVIDER_NOT_CONFIGURED|provider is configured|AI model/i.test(message)) return "candidate_extraction_unavailable";
  return "candidate_extraction_failed";
}
