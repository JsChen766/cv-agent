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
    mutability: "write",
    requiresConfirmation: false,
    riskLevel: "low",
    execute: async (input, context) => {
      const text = String(input.text);
      const job = await context.kernel.productServices.importService.createTextImportJob(context.userId, text);
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
    },
  };
}
