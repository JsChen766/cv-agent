import { z } from "zod";
import type { ApiKernel } from "../../../api/types.js";
import type { AgentToolDefinition } from "../AgentToolTypes.js";
import { objectSchema } from "../schemas.js";

export function createDashboardTools(kernel: ApiKernel): AgentToolDefinition[] {
  return [
    {
      name: "get_dashboard",
      description: "Read the product dashboard summary.",
      schema: z.object({}),
      jsonSchema: objectSchema({}),
      execute: async (_args, context) => {
        const dashboard = await kernel.copilotServices.workspaceService.getDashboard(context.ctx.user.id);
        return {
          status: "success",
          assistantMessage: "已读取你的工作台概览。",
          workspacePatch: {
            activePanel: "experience_library",
            experiences: dashboard.recentExperiences,
            jds: dashboard.recentJDs,
            resumes: dashboard.recentResumes,
          },
        };
      },
    },
    {
      name: "get_sidebar",
      description: "Read sidebar data for recent sessions and assets.",
      schema: z.object({}),
      jsonSchema: objectSchema({}),
      execute: async (_args, context) => {
        const sidebar = await kernel.copilotServices.workspaceService.getSidebar(context.ctx.user.id);
        return {
          status: "success",
          assistantMessage: "已读取侧栏数据。",
          workspacePatch: {
            activePanel: "experience_library",
            experiences: sidebar.recentExperiences,
            jds: sidebar.recentJDs,
            resumes: sidebar.recentResumes,
          },
        };
      },
    },
  ];
}
