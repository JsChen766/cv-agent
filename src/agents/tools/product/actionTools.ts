import { z } from "zod";
import type { ApiKernel } from "../../../api/types.js";
import type { ResumeExportFormat } from "../../../exports/index.js";
import type { ProductExperienceRevision } from "../../../product/types.js";
import type { AgentToolDefinition } from "../AgentToolTypes.js";
import { objectSchema } from "../schemas.js";

export function createProductActionTools(kernel: ApiKernel): AgentToolDefinition[] {
  return [
    {
      name: "optimize_resume_item",
      description: "Create a safe rewrite suggestion for a selected resume item.",
      schema: z.object({
        resumeId: z.string().optional(),
        resumeItemId: z.string().optional(),
        selectedText: z.string().optional(),
        instruction: z.string().optional(),
      }),
      jsonSchema: objectSchema({
        resumeId: { type: "string" },
        resumeItemId: { type: "string" },
        selectedText: { type: "string" },
        instruction: { type: "string" },
      }),
      execute: async (args, context) => {
        const resumeId = nonEmpty(args.resumeId) ?? context.request.clientState?.activeResumeId;
        const resumeItemId = nonEmpty(args.resumeItemId) ?? context.request.clientState?.activeResumeItemId;
        const selectedText = nonEmpty(args.selectedText) ?? context.request.clientState?.selectedText;
        let sourceText = selectedText;
        let title: string | undefined;

        if (!sourceText && resumeId && resumeItemId) {
          const resume = await kernel.productServices.resumeService.getResume(context.ctx.user.id, resumeId);
          const item = resume?.items.find((candidate) => candidate.id === resumeItemId);
          sourceText = nonEmpty(item?.contentSnapshot);
          title = item?.title;
        }

        if (!sourceText) {
          return {
            status: "needs_input",
            assistantMessage: "Please select a resume item or text before optimizing it.",
          };
        }

        const rewrite = await rewriteText(kernel, {
          kind: "resume_item",
          sourceText,
          instruction: normalizeInstruction(args.instruction, "make_more_quantified"),
        });
        return {
          status: "success",
          assistantMessage: `已生成简历条目优化建议${title ? `：${title}` : ""}。\n\n${rewrite.text}`,
          workspacePatch: resumeId ? { activePanel: "resume_editor", resumeId } : undefined,
          timelineItems: [{
            id: `tl-${context.turnId}-resume-item-optimization`,
            type: "revision_completed",
            title: "Resume item optimization prepared",
            description: rewrite.usedModel ? "Generated with the action rewrite model." : "Generated with the local fallback rewriter.",
            status: "completed",
            createdAt: new Date().toISOString(),
          }],
          rawIds: {
            decisionIds: [resumeId, resumeItemId].filter((value): value is string => Boolean(value)),
          },
        };
      },
    },
    {
      name: "rewrite_experience",
      description: "Create a safe rewrite suggestion for a selected experience.",
      schema: z.object({
        experienceId: z.string().optional(),
        selectedText: z.string().optional(),
        instruction: z.string().optional(),
      }),
      jsonSchema: objectSchema({
        experienceId: { type: "string" },
        selectedText: { type: "string" },
        instruction: { type: "string" },
      }),
      execute: async (args, context) => {
        const experienceId = nonEmpty(args.experienceId) ?? context.request.clientState?.activeExperienceId;
        const selectedText = nonEmpty(args.selectedText) ?? context.request.clientState?.selectedText;
        let sourceText = selectedText;
        let title: string | undefined;

        if (!sourceText && experienceId) {
          const experience = await kernel.productServices.experienceService.getExperience(context.ctx.user.id, experienceId);
          const revision = experience
            ? await getCurrentOrLatestRevision(kernel, context.ctx.user.id, experience.id, experience.currentRevisionId)
            : undefined;
          sourceText = nonEmpty(revision?.content);
          title = experience?.title;
        }

        if (!sourceText) {
          return {
            status: "needs_input",
            assistantMessage: "Please select an experience or text before rewriting it.",
          };
        }

        const rewrite = await rewriteText(kernel, {
          kind: "experience",
          sourceText,
          instruction: normalizeInstruction(args.instruction, "rewrite_experience"),
        });
        return {
          status: "success",
          assistantMessage: `已生成经历改写建议${title ? `：${title}` : ""}。\n\n${rewrite.text}`,
          workspacePatch: { activePanel: "experience_library" },
          timelineItems: [{
            id: `tl-${context.turnId}-experience-rewrite`,
            type: "revision_completed",
            title: "Experience rewrite prepared",
            description: rewrite.usedModel ? "Generated with the action rewrite model." : "Generated with the local fallback rewriter.",
            status: "completed",
            createdAt: new Date().toISOString(),
          }],
          rawIds: { decisionIds: experienceId ? [experienceId] : [] },
        };
      },
    },
    {
      name: "export_resume",
      description: "Create a resume export job through the product export service.",
      schema: z.object({
        resumeId: z.string().optional(),
        format: z.enum(["html", "pdf"]).optional(),
        templateId: z.string().optional(),
        payload: z.record(z.string(), z.unknown()).optional(),
      }),
      jsonSchema: objectSchema({
        resumeId: { type: "string" },
        format: { type: "string", enum: ["html", "pdf"] },
        templateId: { type: "string" },
      }),
      execute: async (args, context) => {
        const resumeId = nonEmpty(args.resumeId) ?? context.request.clientState?.activeResumeId ?? context.workspace?.resumeId;
        if (!resumeId) {
          return {
            status: "needs_input",
            assistantMessage: "Please choose a resume before exporting.",
          };
        }

        try {
          const format = (args.format ?? "html") as ResumeExportFormat;
          const result = await kernel.exportService.createExport(context.ctx.user.id, {
            resumeId,
            format,
            templateId: nonEmpty(args.templateId),
          });
          const exportRecord = {
            id: result.exportRecord.id,
            resumeId: result.exportRecord.resumeId,
            format: result.exportRecord.format,
            status: result.exportRecord.status,
            jobId: result.exportRecord.jobId,
            createdAt: result.exportRecord.createdAt,
          };
          return {
            status: "success",
            assistantMessage: `已创建 ${format.toUpperCase()} 导出任务，稍后可以在导出记录中下载。`,
            workspacePatch: {
              activePanel: "resume_editor",
              resumeId,
              activeExportId: result.exportRecord.id,
              exportRecords: [exportRecord],
            },
            timelineItems: [{
              id: `tl-${context.turnId}-resume-export`,
              type: "decision_recorded",
              title: "Resume export created",
              description: `${format.toUpperCase()} export ${result.exportRecord.status}`,
              status: "completed",
              createdAt: new Date().toISOString(),
              relatedExportId: result.exportRecord.id,
            }],
            rawIds: { decisionIds: [result.exportRecord.id, result.job.id] },
            raw: {
              exportId: result.exportRecord.id,
              jobId: result.job.id,
              resumeId,
              format,
              metadata: {
                exportId: result.exportRecord.id,
                jobId: result.job.id,
                resumeId,
                format,
                exportStatus: result.exportRecord.status,
              },
            },
          };
        } catch {
          return {
            status: "failed",
            assistantMessage: "I could not create the resume export. Please try again from the resume export panel.",
          };
        }
      },
    },
  ];
}

async function getCurrentOrLatestRevision(
  kernel: Pick<ApiKernel, "productServices">,
  userId: string,
  experienceId: string,
  currentRevisionId: string | undefined,
): Promise<ProductExperienceRevision | undefined> {
  const revisions = await kernel.productServices.experienceService.listRevisions(userId, experienceId);
  if (currentRevisionId) {
    const current = revisions.find((revision) => revision.id === currentRevisionId);
    if (current) return current;
  }
  return latestRevision(revisions);
}

function latestRevision(revisions: ProductExperienceRevision[]): ProductExperienceRevision | undefined {
  return [...revisions].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
}

async function rewriteText(
  kernel: Pick<ApiKernel, "frontDeskModelClient">,
  input: { kind: "resume_item" | "experience"; sourceText: string; instruction: string },
): Promise<{ text: string; usedModel: boolean }> {
  const modelClient = kernel.frontDeskModelClient;
  if (modelClient) {
    try {
      const response = await modelClient.chat({
        responseFormat: "text",
        temperature: 0.2,
        maxTokens: 260,
        metadata: { agentName: "copilot_action_rewriter", actionKind: input.kind },
        messages: [
          {
            role: "system",
            content: [
              "Rewrite career content into one concise resume-ready item.",
              "Use only facts present in the source text.",
              "Do not invent metrics, employers, dates, technologies, or outcomes.",
              "Return only the rewritten text, no analysis and no markdown.",
            ].join(" "),
          },
          {
            role: "user",
            content: [
              `Content type: ${input.kind}`,
              `Instruction: ${input.instruction}`,
              "Source text:",
              input.sourceText,
            ].join("\n"),
          },
        ],
      });
      const text = cleanRewrite(response.content);
      if (text) return { text, usedModel: true };
    } catch {
      // Fall through to the deterministic fallback; do not expose provider errors to users.
    }
  }
  return {
    text: input.kind === "resume_item"
      ? buildResumeItemSuggestion(input.sourceText, input.instruction)
      : buildExperienceSuggestion(input.sourceText, input.instruction),
    usedModel: false,
  };
}

function cleanRewrite(value: string): string | undefined {
  const text = value.trim().replace(/^```(?:text)?/i, "").replace(/```$/i, "").trim();
  return text.length > 0 ? text.slice(0, 2_000) : undefined;
}

function normalizeInstruction(value: string | undefined, fallback: string): string {
  return nonEmpty(value) ?? fallback;
}

function buildResumeItemSuggestion(sourceText: string, instruction: string | undefined): string {
  const trimmed = sourceText.trim();
  if (instruction === "make_more_conservative") {
    return `${trimmed}\n\n建议：保留已可验证的指标和事实，删除无法支撑的夸张表达。`;
  }
  if (instruction === "custom") {
    return `${trimmed}\n\n建议：按自定义要求调整措辞，但不要新增未经验证的事实。`;
  }
  return `${trimmed}\n\n建议：如有已验证数据，可补充范围、指标和业务结果；不要新增未确认指标。`;
}

function buildExperienceSuggestion(sourceText: string, instruction: string | undefined): string {
  const trimmed = sourceText.trim();
  if (instruction === "make_more_quantified") {
    return `${trimmed}\n\n建议：突出已验证的规模、影响和技术栈；不要新增未经确认的数据。`;
  }
  return `${trimmed}\n\n建议：压缩为简历表达，突出职责、动作和结果，并保持事实可追溯。`;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
