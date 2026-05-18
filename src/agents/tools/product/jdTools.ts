import { z } from "zod";
import type { ApiKernel } from "../../../api/types.js";
import type { AgentToolDefinition } from "../AgentToolTypes.js";
import { objectSchema } from "../schemas.js";

export function createJDTools(kernel: ApiKernel): AgentToolDefinition[] {
  return [
    {
      name: "save_jd",
      description: "Save a job description to the user's JD library.",
      schema: z.object({
        rawText: z.string().optional(),
        targetRole: z.string().optional(),
        company: z.string().optional(),
      }),
      jsonSchema: objectSchema({ rawText: { type: "string" }, targetRole: { type: "string" }, company: { type: "string" } }),
      execute: async (args, context) => {
        const rawText = args.rawText ?? context.session.jdText ?? context.request.jdText;
        if (!rawText?.trim()) return { status: "needs_input", assistantMessage: "请先粘贴 JD 文本。" };
        const jd = await kernel.productServices.jdService.saveJD(context.ctx.user.id, {
          rawText,
          targetRole: args.targetRole ?? context.session.targetRole ?? context.request.targetRole,
          company: args.company,
        });
        const jds = await kernel.productServices.jdService.listJDs(context.ctx.user.id);
        return {
          status: "success",
          assistantMessage: `已保存 JD：${jd.title}`,
          workspacePatch: { activePanel: "jd_library", jds, jdId: jd.id },
          rawIds: { decisionIds: [jd.id] },
        };
      },
    },
    {
      name: "list_jds",
      description: "List saved job descriptions.",
      schema: z.object({ limit: z.number().int().positive().optional() }),
      jsonSchema: objectSchema({ limit: { type: "number" } }),
      execute: async (args, context) => {
        const jds = await kernel.productServices.jdService.listJDs(context.ctx.user.id, args.limit);
        return {
          status: "success",
          assistantMessage: jds.length > 0 ? `找到 ${jds.length} 条 JD。` : "还没有保存过 JD。",
          workspacePatch: { activePanel: "jd_library", jds },
          rawIds: { decisionIds: jds.map((item) => item.id) },
        };
      },
    },
  ];
}
