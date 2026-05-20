import { z } from "zod";
import type { ApiKernel } from "../../../api/types.js";
import type { CopilotActionResult } from "../../../copilot/types.js";
import type { ResumeExportFormat } from "../../../exports/index.js";
import type { ProductExperienceRevision } from "../../../product/types.js";
import type { AgentToolDefinition } from "../AgentToolTypes.js";
import { objectSchema } from "../schemas.js";

const SOURCE_PREVIEW_LIMIT = 300;
const REWRITE_LIMIT = 3_000;

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
          const message = "Please select resume text or choose a resume item before optimizing it.";
          return {
            status: "needs_input",
            assistantMessage: message,
            actionResult: needsInputActionResult("optimize_resume_item", message, selectedText ? ["resumeItemId"] : ["selectedText", "resumeItemId"]),
          };
        }

        try {
          const rewrite = await rewriteText(kernel, {
            kind: "resume_item",
            sourceText,
            instruction: normalizeInstruction(args.instruction, "make_more_quantified"),
          });
          const message = `Generated a resume item optimization suggestion${title ? ` for ${title}` : ""}.`;
          return {
            status: "success",
            assistantMessage: `${message}\n\n${rewrite.text}`,
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
            actionResult: {
              actionType: "optimize_resume_item",
              status: "success",
              message,
              revisionSuggestion: {
                kind: "resume_item",
                sourceId: resumeItemId,
                sourceTextPreview: preview(sourceText, SOURCE_PREVIEW_LIMIT),
                rewrittenText: limitText(rewrite.text, REWRITE_LIMIT),
                usedModel: rewrite.usedModel,
              },
            },
          };
        } catch {
          const message = "I could not generate the resume item rewrite suggestion.";
          return {
            status: "failed",
            assistantMessage: message,
            actionResult: {
              actionType: "optimize_resume_item",
              status: "failed",
              message,
              reason: "rewrite_failed",
            },
          };
        }
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
          const message = "Please select experience text or choose an experience before rewriting it.";
          return {
            status: "needs_input",
            assistantMessage: message,
            actionResult: needsInputActionResult("rewrite_experience", message, selectedText ? ["experienceId"] : ["selectedText", "experienceId"]),
          };
        }

        try {
          const rewrite = await rewriteText(kernel, {
            kind: "experience",
            sourceText,
            instruction: normalizeInstruction(args.instruction, "rewrite_experience"),
          });
          const message = `Generated an experience rewrite suggestion${title ? ` for ${title}` : ""}.`;
          return {
            status: "success",
            assistantMessage: `${message}\n\n${rewrite.text}`,
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
            actionResult: {
              actionType: "rewrite_experience",
              status: "success",
              message,
              revisionSuggestion: {
                kind: "experience",
                sourceId: experienceId,
                sourceTextPreview: preview(sourceText, SOURCE_PREVIEW_LIMIT),
                rewrittenText: limitText(rewrite.text, REWRITE_LIMIT),
                usedModel: rewrite.usedModel,
              },
            },
          };
        } catch {
          const message = "I could not generate the experience rewrite suggestion.";
          return {
            status: "failed",
            assistantMessage: message,
            actionResult: {
              actionType: "rewrite_experience",
              status: "failed",
              message,
              reason: "rewrite_failed",
            },
          };
        }
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
          const message = "Please choose a resume before exporting.";
          return {
            status: "needs_input",
            assistantMessage: message,
            actionResult: needsInputActionResult("export_resume", message, ["resumeId"]),
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
          const message = `Created a ${format.toUpperCase()} export job. It will be available in export records when ready.`;
          return {
            status: "success",
            assistantMessage: message,
            workspacePatch: {
              activePanel: "resume_editor",
              resumeId,
              activeExportId: result.exportRecord.id,
              exportRecords: [exportRecord],
            },
            timelineItems: [{
              id: `tl-${context.turnId}-resume-export`,
              type: "export_created",
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
            actionResult: {
              actionType: "export_resume",
              status: "success",
              message,
              exportRecord,
            },
          };
        } catch {
          const message = "I could not create the resume export. Please try again from the resume export panel.";
          return {
            status: "failed",
            assistantMessage: message,
            actionResult: {
              actionType: "export_resume",
              status: "failed",
              message,
              reason: "export_create_failed",
            },
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
      // Fall through to deterministic fallback; provider details must not leak.
    }
  }
  return {
    text: input.kind === "resume_item"
      ? buildResumeItemSuggestion(input.sourceText, input.instruction)
      : buildExperienceSuggestion(input.sourceText, input.instruction),
    usedModel: false,
  };
}

function needsInputActionResult(actionType: string, message: string, missingInputs: string[]): CopilotActionResult {
  return { actionType, status: "needs_input", message, missingInputs };
}

function cleanRewrite(value: string): string | undefined {
  const text = value.trim().replace(/^```(?:text)?/i, "").replace(/```$/i, "").trim();
  return text.length > 0 ? limitText(text, REWRITE_LIMIT) : undefined;
}

function normalizeInstruction(value: string | undefined, fallback: string): string {
  return nonEmpty(value) ?? fallback;
}

function buildResumeItemSuggestion(sourceText: string, instruction: string | undefined): string {
  const trimmed = sourceText.trim();
  if (instruction === "make_more_conservative") {
    return `${trimmed}\n\nSuggestion: keep only verified metrics and claims; remove unsupported exaggeration.`;
  }
  if (instruction === "custom") {
    return `${trimmed}\n\nSuggestion: adjust wording to the custom instruction without adding unverified facts.`;
  }
  return `${trimmed}\n\nSuggestion: add verified scope, metric, and business outcome where available; do not invent unconfirmed numbers.`;
}

function buildExperienceSuggestion(sourceText: string, instruction: string | undefined): string {
  const trimmed = sourceText.trim();
  if (instruction === "make_more_quantified") {
    return `${trimmed}\n\nSuggestion: emphasize verified scope, impact, and technologies; do not add unconfirmed data.`;
  }
  return `${trimmed}\n\nSuggestion: make this resume-ready by focusing on responsibility, action, and result while keeping facts traceable.`;
}

function preview(value: string, limit: number): string {
  return limitText(value.replace(/\s+/g, " ").trim(), limit);
}

function limitText(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
