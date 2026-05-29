import type { ToolResult } from "../tools/ToolResult.js";
import {
  isCanonicalEvidenceChainId,
  isCanonicalEvidenceId,
  isCanonicalExperienceId,
  isCanonicalGenerationId,
  isCanonicalJDId,
  isCanonicalResumeId,
  isCanonicalResumeItemId,
  isCanonicalVariantId,
} from "../../copilot/context/IdGuards.js";

export type NormalizedShowEvidenceArgs = {
  id?: string;
  variantId?: string;
  evidenceId?: string;
  evidenceChainId?: string;
  generationId?: string;
};

export function normalizeShowEvidenceArgs(args: Record<string, unknown>): NormalizedShowEvidenceArgs & Record<string, unknown> {
  const normalized: NormalizedShowEvidenceArgs & Record<string, unknown> = { ...args };
  const id = stringValue(args.id);
  if (id) {
    normalized.id = id;
    if (isCanonicalVariantId(id)) normalized.variantId = stringValue(args.variantId) ?? id;
    else if (isCanonicalEvidenceId(id)) normalized.evidenceId = stringValue(args.evidenceId) ?? id;
    else if (isCanonicalGenerationId(id)) normalized.generationId = stringValue(args.generationId) ?? id;
    else normalized.__invalidShowEvidenceId = id;
  }
  normalized.variantId = stringValue(normalized.variantId);
  normalized.evidenceId = stringValue(normalized.evidenceId);
  normalized.evidenceChainId = stringValue(normalized.evidenceChainId);
  normalized.generationId = stringValue(normalized.generationId);
  return normalized;
}

export function guardToolIds(toolName: string, args: Record<string, unknown>): ToolResult | undefined {
  if (["get_experience", "match_experience", "update_experience", "prepare_update_experience", "delete_experience", "prepare_delete_experience"].includes(toolName)) {
    const id = stringValue(args.experienceId) ?? stringValue(args.id);
    if (id && !isCanonicalExperienceId(id)) return needsInput(toolName, "experienceId", "Please select a valid experience from your experience library.");
  }

  if (["get_jd", "match_experience"].includes(toolName)) {
    const jdId = stringValue(args.jdId) ?? stringValue(args.id);
    if (jdId && !isCanonicalJDId(jdId)) return needsInput(toolName, "jdId", "Please select a valid JD from your JD library.");
  }

  if (["get_resume", "export_resume", "prepare_export_resume"].includes(toolName)) {
    const resumeId = stringValue(args.resumeId) ?? stringValue(args.id);
    if (resumeId && !isCanonicalResumeId(resumeId)) return needsInput(toolName, "resumeId", "Please select a valid resume from your resume library.");
  }

  if (toolName === "generate_resume_from_jd") {
    const jdId = stringValue(args.jdId);
    if (jdId && !isCanonicalJDId(jdId)) return needsInput(toolName, "jdId", "Please select a valid JD from your JD library.");
  }

  if (toolName === "accept_generation_variant") {
    const generationId = stringValue(args.generationId);
    if (generationId && !isCanonicalGenerationId(generationId)) return needsInput(toolName, "generationId", "Please select a valid generation result.");
    const resumeId = stringValue(args.resumeId);
    if (resumeId && !isCanonicalResumeId(resumeId)) return needsInput(toolName, "resumeId", "Please select a valid resume from your resume library.");
    const variantId = stringValue(args.variantId);
    if (variantId && !isCanonicalVariantId(variantId)) return needsInput(toolName, "variantId", "Please select a valid generated variant.");
  }

  if (toolName === "revise_resume_item") {
    const resumeItemId = stringValue(args.resumeItemId);
    if (resumeItemId && !isCanonicalResumeItemId(resumeItemId)) return needsInput(toolName, "resumeItemId", "Please select a valid resume item.");
  }

  if (toolName === "show_evidence") {
    const normalized = normalizeShowEvidenceArgs(args);
    if (normalized.__invalidShowEvidenceId) return needsInput(toolName, "id", "Please select a valid variant, evidence item, or generation result.");
    if (normalized.variantId && !isCanonicalVariantId(normalized.variantId)) return needsInput(toolName, "variantId", "Please select a valid generated variant.");
    if (normalized.evidenceId && !isCanonicalEvidenceId(normalized.evidenceId)) return needsInput(toolName, "evidenceId", "Please select a valid evidence item.");
    if (normalized.evidenceChainId && !isCanonicalEvidenceChainId(normalized.evidenceChainId)) return needsInput(toolName, "evidenceChainId", "Please select a valid evidence chain.");
    if (normalized.generationId && !isCanonicalGenerationId(normalized.generationId)) return needsInput(toolName, "generationId", "Please select a valid generation result.");
  }

  return undefined;
}

export function stripInternalToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([key]) => !key.startsWith("__")));
}

function needsInput(toolName: string, field: string, message: string): ToolResult {
  return {
    status: "needs_input",
    message,
    visibility: "error_user_visible",
    actionResult: {
      actionType: toolName,
      status: "needs_input",
      missingInputs: [field],
      message,
    },
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
