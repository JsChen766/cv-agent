import { z } from "zod";
import type { ApiKernel } from "../../../api/types.js";
import type { ProductExperienceCategory } from "../../../product/types.js";
import type { AgentToolDefinition } from "../AgentToolTypes.js";
import { inferTitle } from "../helpers.js";
import { objectSchema } from "../schemas.js";

export function createExperienceTools(kernel: ApiKernel): AgentToolDefinition[] {
  return [
    {
      name: "list_experiences",
      description: "List the user's saved experience library.",
      schema: z.object({ limit: z.number().int().positive().optional() }),
      jsonSchema: objectSchema({ limit: { type: "number" } }),
      execute: async (args, context) => {
        const experiences = await kernel.productServices.experienceService.listExperiences(context.ctx.user.id, { limit: args.limit });
        return {
          status: "success",
          assistantMessage: experiences.length > 0 ? `找到 ${experiences.length} 条经历。` : "你的经历库目前为空，可以把一段经历发给我保存。",
          workspacePatch: { activePanel: "experience_library", experiences },
          rawIds: { decisionIds: experiences.map((item) => item.id) },
        };
      },
    },
    {
      name: "create_experience",
      description: "Save a new experience into the product experience library.",
      schema: z.object({
        title: z.string().optional(),
        category: z.enum(["work", "project", "education", "award", "skill", "other"]).optional(),
        content: z.string().min(8),
        organization: z.string().optional(),
        role: z.string().optional(),
        tags: z.array(z.string()).optional(),
      }),
      jsonSchema: objectSchema({ title: { type: "string" }, category: { type: "string" }, content: { type: "string" } }, ["content"]),
      execute: async (args, context) => {
        const created = await kernel.productServices.experienceService.createExperience(context.ctx.user.id, {
          title: args.title ?? inferTitle(args.content, "新的经历"),
          category: args.category as ProductExperienceCategory | undefined,
          content: args.content,
          organization: args.organization,
          role: args.role,
          tags: args.tags,
          source: "copilot",
        });
        const experiences = await kernel.productServices.experienceService.listExperiences(context.ctx.user.id);
        return {
          status: "success",
          assistantMessage: `已保存到经历库：${created.experience.title}`,
          workspacePatch: { activePanel: "experience_library", experiences },
          rawIds: { decisionIds: [created.experience.id] },
        };
      },
    },
    {
      name: "update_experience",
      description: "Update metadata for an existing experience.",
      schema: z.object({
        experienceId: z.string().min(1),
        title: z.string().optional(),
        organization: z.string().optional(),
        role: z.string().optional(),
        tags: z.array(z.string()).optional(),
      }),
      jsonSchema: objectSchema({ experienceId: { type: "string" }, title: { type: "string" } }, ["experienceId"]),
      execute: async (args, context) => {
        const updated = await kernel.productServices.experienceService.updateExperience(context.ctx.user.id, args.experienceId, {
          title: args.title,
          organization: args.organization,
          role: args.role,
          ...(args.tags ? { tags: args.tags } : {}),
        });
        if (!updated) return { status: "failed", assistantMessage: "没有找到这条经历。" };
        const experiences = await kernel.productServices.experienceService.listExperiences(context.ctx.user.id);
        return {
          status: "success",
          assistantMessage: `已更新经历：${updated.title}`,
          workspacePatch: { activePanel: "experience_library", experiences },
          rawIds: { decisionIds: [updated.id] },
        };
      },
    },
  ];
}
