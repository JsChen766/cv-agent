import { z } from "zod";
import type { ApiKernel } from "../../../api/types.js";
import type { AgentToolDefinition } from "../AgentToolTypes.js";
import { objectSchema } from "../schemas.js";

export function createImportTools(kernel: ApiKernel): AgentToolDefinition[] {
  return [
    {
      name: "import_resume_text",
      description: "Import resume text and create experience candidates.",
      schema: z.object({ rawText: z.string().optional() }),
      jsonSchema: objectSchema({ rawText: { type: "string" } }),
      execute: async (args, context) => {
        const rawText = args.rawText ?? context.request.resumeText ?? context.request.message;
        if (!rawText.trim()) return { status: "needs_input", assistantMessage: "请粘贴要导入的简历文本。" };
        const job = await kernel.productServices.importService.createTextImportJob(context.ctx.user.id, rawText);
        const candidates = await kernel.productServices.importService.createCandidatesFromText(context.ctx.user.id, job.id);
        return {
          status: "success",
          assistantMessage: `已从简历文本中整理出 ${candidates.length} 条候选经历。`,
          workspacePatch: { activePanel: "import_candidates", importCandidates: candidates },
          rawIds: { decisionIds: [job.id, ...candidates.map((item) => item.id)] },
        };
      },
    },
    {
      name: "accept_import_candidate",
      description: "Accept an imported experience candidate and save it to the library.",
      schema: z.object({ candidateId: z.string().min(1) }),
      jsonSchema: objectSchema({ candidateId: { type: "string" } }, ["candidateId"]),
      execute: async (args, context) => {
        const result = await kernel.productServices.importService.acceptCandidate(context.ctx.user.id, args.candidateId);
        const experiences = await kernel.productServices.experienceService.listExperiences(context.ctx.user.id);
        return {
          status: "success",
          assistantMessage: `已确认候选经历，并保存为：${result.experience.title}`,
          workspacePatch: { activePanel: "experience_library", experiences },
          rawIds: { decisionIds: [result.experience.id] },
        };
      },
    },
  ];
}
