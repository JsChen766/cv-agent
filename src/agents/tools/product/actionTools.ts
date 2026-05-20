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

        const suggestion = buildResumeItemSuggestion(sourceText, args.instruction);
        return {
          status: "success",
          assistantMessage: `Suggested resume item revision${title ? ` for ${title}` : ""}:\n\n${suggestion}`,
          workspacePatch: resumeId ? { activePanel: "resume_editor", resumeId } : undefined,
          timelineItems: [{
            id: `tl-${context.turnId}-resume-item-optimization`,
            type: "revision_completed",
            title: "Resume item optimization prepared",
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

        const suggestion = buildExperienceSuggestion(sourceText, args.instruction);
        return {
          status: "success",
          assistantMessage: `Suggested experience rewrite${title ? ` for ${title}` : ""}:\n\n${suggestion}`,
          workspacePatch: { activePanel: "experience_library" },
          timelineItems: [{
            id: `tl-${context.turnId}-experience-rewrite`,
            type: "revision_completed",
            title: "Experience rewrite prepared",
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
          const result = await kernel.exportService.createExport(context.ctx.user.id, {
            resumeId,
            format: (args.format ?? "html") as ResumeExportFormat,
            templateId: nonEmpty(args.templateId),
          });
          return {
            status: "success",
            assistantMessage: `Export job created for this resume. Export ID: ${result.exportRecord.id}.`,
            workspacePatch: { activePanel: "resume_editor", resumeId },
            timelineItems: [{
              id: `tl-${context.turnId}-resume-export`,
              type: "decision_recorded",
              title: "Resume export created",
              status: "completed",
              createdAt: new Date().toISOString(),
            }],
            rawIds: { decisionIds: [result.exportRecord.id, result.job.id] },
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

function buildResumeItemSuggestion(sourceText: string, instruction: string | undefined): string {
  const trimmed = sourceText.trim();
  if (instruction === "make_more_conservative") {
    return `${trimmed}\n\nVerification note: keep only metrics and claims that are supported by your source material.`;
  }
  return `${trimmed}\n\nQuantification note: add verified scope, metric, and business outcome where available.`;
}

function buildExperienceSuggestion(sourceText: string, instruction: string | undefined): string {
  const trimmed = sourceText.trim();
  if (instruction === "make_more_quantified") {
    return `${trimmed}\n\nRewrite direction: emphasize measurable scope, impact, and tools, using only verified facts.`;
  }
  return `${trimmed}\n\nRewrite direction: make the experience concise, role-aligned, and evidence-backed.`;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
