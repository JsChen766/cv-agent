import type { AgentContext } from "../runtime/AgentContext.js";
import type { ToolResult } from "../tools/ToolResult.js";
import type { CopilotWorkspace, ProductVariant } from "../../copilot/types.js";
import { normalizeShowEvidenceArgs } from "./ToolIdGuard.js";

type ResolverConflict = {
  field: string;
  explicitId?: string;
  activeId?: string;
  workspaceId?: string;
  decision: "rejected" | "explicit_preferred";
};

const CONFLICT_REJECT_TOOLS = new Set([
  "update_experience",
  "prepare_update_experience",
  "delete_experience",
  "prepare_delete_experience",
  "accept_generation_variant",
  "export_resume",
  "prepare_export_resume",
]);

export async function guardToolScope(
  toolName: string,
  args: Record<string, unknown>,
  context: AgentContext,
  workspace: CopilotWorkspace | null,
): Promise<ToolResult | undefined> {
  const conflictResult = guardResolverConflicts(toolName, args);
  if (conflictResult) return conflictResult;

  if (["get_experience", "update_experience", "prepare_update_experience", "delete_experience", "prepare_delete_experience"].includes(toolName)) {
    const experienceId = stringValue(args.experienceId) ?? stringValue(args.id);
    if (!experienceId) return undefined;
    const activeId = context.clientState?.activeExperienceId ?? workspace?.active?.experienceId;
    if (CONFLICT_REJECT_TOOLS.has(toolName) && activeId && activeId !== experienceId) {
      return needsInput(toolName, "experienceId", "The selected experience changed. Please choose the experience again.");
    }
    const experience = await context.kernel.productServices.experienceService.getExperience(context.userId, experienceId);
    if (!experience) return needsInput(toolName, "experienceId", "Experience not found. Please choose an existing experience.");
  }

  if (["get_resume", "export_resume", "prepare_export_resume"].includes(toolName)) {
    const resumeId = stringValue(args.resumeId) ?? stringValue(args.id);
    if (!resumeId) return undefined;
    const resume = await context.kernel.productServices.resumeService.getResume(context.userId, resumeId);
    if (!resume) return needsInput(toolName, "resumeId", "Resume not found. Please choose an existing resume.");
  }

  if (["get_jd", "generate_resume_from_jd"].includes(toolName)) {
    const jdId = stringValue(args.jdId) ?? stringValue(args.id);
    if (!jdId) return undefined;
    const jd = await context.kernel.productServices.jdService.getJD(context.userId, jdId);
    if (!jd) return needsInput(toolName, "jdId", "JD not found. Please choose an existing JD.");
  }

  if (toolName === "accept_generation_variant") {
    const generationId = stringValue(args.generationId);
    const variantId = stringValue(args.variantId);
    if (!generationId || !variantId) return undefined;
    if (workspace?.productGenerationId && workspace.productGenerationId !== generationId) {
      return needsInput(toolName, "generationId", "The selected generation changed. Please choose the generation result again.");
    }
    const generation = await context.kernel.productServices.generationProductService.getGeneration(context.userId, generationId);
    if (!generation) return needsInput(toolName, "generationId", "Generation not found. Please regenerate or choose an existing generation.");
    if (generation.sessionId && generation.sessionId !== context.sessionId) {
      return needsInput(toolName, "generationId", "This generation belongs to another session. Please reopen the correct session.");
    }
    const variants = generation.outputSnapshot?.variants ?? [];
    if (!variants.some((variant) => variant.id === variantId)) {
      return needsInput(toolName, "variantId", "Variant not found in this generation. Please select a real generated variant.");
    }
    const workspaceResumeId = workspace?.resumeId ?? workspace?.active?.resumeId;
    const resumeId = stringValue(args.resumeId);
    if (resumeId) {
      if (workspaceResumeId && workspaceResumeId !== resumeId) {
        return needsInput(toolName, "resumeId", "The selected resume changed. Please choose the target resume again.");
      }
      const resume = await context.kernel.productServices.resumeService.getResume(context.userId, resumeId);
      if (!resume) return needsInput(toolName, "resumeId", "Resume not found. Please choose an existing resume.");
    }
  }

  if (toolName === "show_evidence") {
    const normalized = normalizeShowEvidenceArgs(args);
    const variantId = stringValue(normalized.variantId);
    const evidenceChainId = stringValue(normalized.evidenceChainId);
    const evidenceId = stringValue(normalized.evidenceId);
    const generationId = stringValue(normalized.generationId);
    if (!variantId && !evidenceChainId && !evidenceId && !generationId) {
      return needsInput(toolName, "variantId", "Please select a variant, evidence chain, evidence item, or generation result.");
    }
    if (variantId && !workspaceVariant(workspace, variantId)) {
      return needsInput(toolName, "variantId", "Variant not found in the current workspace.");
    }
    if (evidenceChainId && !workspaceVariant(workspace, evidenceChainId)) {
      return needsInput(toolName, "evidenceChainId", "Evidence chain not found in the current workspace.");
    }
    if (evidenceId && !workspaceEvidenceExists(workspace, evidenceId)) {
      return needsInput(toolName, "evidenceId", "Evidence item not found in the current workspace.");
    }
    if (generationId && workspace?.productGenerationId !== generationId) {
      const generation = await context.kernel.productServices.generationProductService.getGeneration(context.userId, generationId);
      if (!generation || (generation.sessionId && generation.sessionId !== context.sessionId)) {
        return needsInput(toolName, "generationId", "Generation not found in the current workspace.");
      }
    }
  }

  return undefined;
}

function guardResolverConflicts(toolName: string, args: Record<string, unknown>): ToolResult | undefined {
  if (!CONFLICT_REJECT_TOOLS.has(toolName)) return undefined;
  const conflicts = Array.isArray(args.__resolverConflicts) ? args.__resolverConflicts as ResolverConflict[] : [];
  const rejected = conflicts.find((conflict) => conflict.decision === "rejected");
  if (!rejected) return undefined;
  return needsInput(toolName, rejected.field, "The selected asset conflicts with the active workspace. Please choose the target again.");
}

function workspaceVariant(workspace: CopilotWorkspace | null, id: string): ProductVariant | undefined {
  return workspace?.variants?.find((variant) => variant.id === id);
}

function workspaceEvidenceExists(workspace: CopilotWorkspace | null, id: string): boolean {
  return Boolean(workspace?.variants?.some((variant) =>
    variant.sourceExperienceIds?.includes(id)
    || variant.sourceEvidenceIds?.includes(id)
    || variant.evidenceSummary?.items?.some((item) => item.id === id),
  ));
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
