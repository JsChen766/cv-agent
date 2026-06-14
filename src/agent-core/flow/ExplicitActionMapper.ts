import { randomUUID } from "node:crypto";
import type { ActiveAssetContext } from "../../copilot/ActiveAssetContextBuilder.js";
import { mostRecentJDDraft } from "../../copilot/context/DraftContext.js";
import { isCanonicalGenerationId, isCanonicalVariantId } from "../../copilot/context/IdGuards.js";
import type { CopilotActionRequest, CopilotWorkspace } from "../../copilot/types.js";
import { computeJDHash } from "../../product/jdHash.js";
import { sanitizeExperiencePatch } from "../security/ToolPatchSanitizer.js";
import type { AgentName, PlanStep } from "../validation/AgentOutputSchemas.js";
import type { ExplicitActionMappingResult } from "./FlowIntent.js";

export type ExplicitActionMapperInput = {
  request: CopilotActionRequest;
  workspace: CopilotWorkspace | null;
  activeAssetContext?: ActiveAssetContext;
};

export class ExplicitActionMapper {
  public map(input: ExplicitActionMapperInput): ExplicitActionMappingResult {
    const { request, workspace } = input;
    const payload = request.action.payload ?? {};
    const clientState = request.clientState ?? {};
    const ctx = input.activeAssetContext;
    const jdDraft = mostRecentJDDraft(workspace);

    const resolve = {
      experienceId: () =>
        stringValue(payload.experienceId) ?? clientState.activeExperienceId ?? workspace?.active?.experienceId ?? ctx?.activeExperience?.id,
      resumeItemId: () =>
        stringValue(payload.resumeItemId) ?? clientState.activeResumeItemId ?? ctx?.activeResume?.selectedItem?.id,
      resumeId: () =>
        stringValue(payload.resumeId) ?? clientState.activeResumeId ?? workspace?.resumeId ?? workspace?.activeResume?.id ?? ctx?.activeResume?.id,
      jdId: () =>
        stringValue(payload.jdId) ?? clientState.activeJDId ?? workspace?.active?.jdId ?? workspace?.jdId ?? ctx?.activeJD?.id,
      jdText: () =>
        stringValue(payload.jdText) ?? stringValue(payload.text) ?? jdDraft?.rawText ?? ctx?.activeJD?.rawTextPreview ?? clientState.selectedText,
      variantId: () =>
        stringValue(payload.variantId) ?? request.action.variantId ?? clientState.activeVariantId ?? workspace?.activeVariantId ?? ctx?.activeVariant?.id,
      generationId: () =>
        stringValue(payload.generationId) ?? workspace?.productGenerationId,
      evidenceId: () =>
        stringValue(payload.evidenceId) ?? clientState.activeEvidenceId,
      content: () =>
        stringValue(payload.content) ?? stringValue(payload.rewrittenText) ?? stringValue(payload.after),
      selectedText: () =>
        stringValue(payload.selectedText) ?? stringValue(payload.instruction) ?? clientState.selectedText ?? ctx?.activeResume?.selectedItem?.contentPreview,
    };

    switch (request.action.type) {
      case "list_experiences":
        return { kind: "step", step: explicitStep("experience_receiver", "list_experiences", {
          limit: numberValue(payload.limit),
        }, "List experiences.") };

      case "search_experiences": {
        const query = stringValue(payload.query) ?? stringValue(payload.keyword);
        if (!query) {
          return { kind: "needs_input", missingInputs: ["query"], message: "Please provide a keyword to search experiences." };
        }
        return { kind: "step", step: explicitStep("experience_receiver", "search_experiences", {
          query,
          limit: numberValue(payload.limit),
        }, "Search experiences.") };
      }

      case "get_experience":
      case "open_inspector": {
        const experienceId = resolve.experienceId();
        if (!experienceId) {
          return { kind: "needs_input", missingInputs: ["experienceId"], message: "Please choose an experience first." };
        }
        return { kind: "step", step: explicitStep("experience_receiver", "get_experience", { id: experienceId }, "Open experience detail.") };
      }

      case "save_experience_from_text": {
        const text = stringValue(payload.text) ?? stringValue(payload.content) ?? stringValue(payload.rawText);
        if (!text) {
          return { kind: "needs_input", missingInputs: ["text"], message: "Please provide experience text to save." };
        }
        return { kind: "step", step: explicitStep("experience_receiver", "save_experience_from_text", { text }, "Save experience from text.") };
      }

      case "save_jd_from_text": {
        const jdText =
          stringValue(payload.jdText)
          ?? stringValue(payload.rawText)
          ?? stringValue(payload.text)
          ?? resolve.jdText();
        if (!jdText) {
          return { kind: "needs_input", missingInputs: ["jdText"], message: "Please provide JD text to save." };
        }
        return {
          kind: "step",
          step: explicitStep("experience_receiver", "save_jd_from_text", {
            text: jdText,
            title: stringValue(payload.title),
            company: stringValue(payload.company),
            targetRole: stringValue(payload.targetRole),
          }, "Save JD after confirmation."),
        };
      }

      case "analyze_jd": {
        const jdText =
          stringValue(payload.jdText)
          ?? stringValue(payload.rawText)
          ?? stringValue(payload.text)
          ?? resolve.jdText();
        if (!jdText) {
          return { kind: "needs_input", missingInputs: ["jdText"], message: "Please provide JD text to analyze." };
        }
        return { kind: "step", step: explicitStep("strategist", "analyze_jd", { text: jdText }, "Analyze JD and recommend next actions.") };
      }

      case "update_experience": {
        const experienceId = resolve.experienceId();
        if (!experienceId) {
          return { kind: "needs_input", missingInputs: ["experienceId"], message: "Please choose an experience first." };
        }
        const content = resolve.content();
        const patch = isRecord(payload.patch) ? sanitizeExperiencePatch(payload.patch) : {};
        if (!content && Object.keys(patch).length === 0) {
          return { kind: "needs_input", missingInputs: ["content_or_patch"], message: "Please provide update fields or rewritten content." };
        }
        return { kind: "step", step: explicitStep("experience_receiver", "update_experience", {
          experienceId,
          patch,
          ...(content ? { content } : {}),
        }, "Update experience after confirmation.") };
      }

      case "match_experience": {
        const experienceId = resolve.experienceId();
        if (!experienceId) {
          return { kind: "needs_input", missingInputs: ["experienceId"], message: "Please choose an experience to match." };
        }
        const jdId = resolve.jdId();
        const jdText = resolve.jdText();
        if (!jdId && !jdText) {
          return { kind: "needs_input", missingInputs: ["jdId", "jdText"], message: "Please provide JD content before matching." };
        }
        return { kind: "step", step: explicitStep("experience_receiver", "match_experience", {
          experienceId,
          jdId,
          jdText,
        }, "Match experience against JD.") };
      }

      case "rewrite_experience": {
        const experienceId = resolve.experienceId();
        if (!experienceId) {
          return { kind: "needs_input", missingInputs: ["experienceId"], message: "请先选择一条经历，或打开经历详情后再让我改写。" };
        }
        const content = resolve.content();
        if (!content) {
          return { kind: "needs_input", missingInputs: ["content"], message: "我已找到这条经历，但还没有生成改写后的正文。请先让我生成改写版本。" };
        }
        return { kind: "step", step: explicitStep("experience_receiver", "update_experience", {
          experienceId,
          patch: {},
          content,
        }, "Rewrite experience after confirmation.") };
      }

      case "optimize_resume_item": {
        const resumeItemId = resolve.resumeItemId();
        if (!resumeItemId) {
          return { kind: "needs_input", missingInputs: ["resumeItemId"], message: "请先选择一条简历内容，再让我优化。" };
        }
        const instruction = resolve.selectedText() ?? "优化这段简历内容。";
        return { kind: "step", step: explicitStep("architect", "revise_resume_item", {
          resumeItemId,
          instruction,
        }, "Revise resume item after confirmation.") };
      }

      case "generate_from_jd": {
        const jdId = resolve.jdId();
        const jdText = resolve.jdText();
        if (!jdId && !jdText) {
          return { kind: "needs_input", missingInputs: ["jdId", "jdText"], message: "请先选择或粘贴一段 JD。" };
        }
        const jdHash = jdText ? computeJDHash(jdText) : undefined;
        return { kind: "step", step: explicitStep("architect", "generate_resume_from_jd", {
          jdId,
          jdText,
          jdHash,
          jdSaved: Boolean(payload.jdSaved) || Boolean(jdId),
          targetRole: stringValue(payload.targetRole),
        }, "Generate resume from JD after confirmation.") };
      }

      case "show_evidence":
      case "explain_choice": {
        const evidenceId = resolve.evidenceId();
        const variantId = resolve.variantId();
        const generationId = resolve.generationId();
        const id = evidenceId ?? variantId ?? generationId;
        if (!id) {
          return { kind: "needs_input", missingInputs: ["evidenceId", "variantId", "generationId"], message: "请先选择一个生成版本或证据项。" };
        }
        return { kind: "step", step: explicitStep("critic", "show_evidence", {
          id,
          variantId,
          generationId,
          evidenceId,
        }, "Show evidence.") };
      }

      case "export_resume": {
        const resumeId = resolve.resumeId();
        if (!resumeId) {
          return { kind: "needs_input", missingInputs: ["resumeId"], message: "请先打开一份简历，再进行导出。" };
        }
        return { kind: "step", step: explicitStep("architect", "export_resume", {
          resumeId,
          format: payload.format ?? "html",
          templateId: stringValue(payload.templateId),
        }, "Export resume after confirmation.") };
      }

      case "accept": {
        const variantId = resolve.variantId();
        if (!variantId) {
          return { kind: "needs_input", missingInputs: ["variantId"], message: "请先选择一个生成版本。" };
        }
        if (!isCanonicalVariantId(variantId)) {
          return { kind: "needs_input", missingInputs: ["variantId"], message: "我需要先确认你指的是哪个版本，请从版本列表中选择。" };
        }
        const generationId = resolve.generationId();
        if (!generationId) {
          return { kind: "needs_input", missingInputs: ["generationId"], message: "请先打开一次生成结果，或重新生成简历版本。" };
        }
        if (!isCanonicalGenerationId(generationId)) {
          return { kind: "needs_input", missingInputs: ["generationId"], message: "我需要先确认你指的是哪次生成结果，请从生成历史中选择。" };
        }
        const resumeId = resolve.resumeId();
        return { kind: "step", step: explicitStep("architect", "accept_generation_variant", {
          generationId,
          variantId,
          resumeId,
        }, "Accept variant after confirmation.") };
      }

      case "reject": {
        const variantId = resolve.variantId();
        if (!variantId) {
          return { kind: "needs_input", missingInputs: ["variantId"], message: "请先选择一个生成版本。" };
        }
        if (!isCanonicalVariantId(variantId)) {
          return { kind: "needs_input", missingInputs: ["variantId"], message: "我需要先确认你指的是哪个版本，请从版本列表中选择。" };
        }
        return { kind: "needs_input", missingInputs: [], message: "已标记该版本为不采用。如需其他版本，请选择后点击接受。" };
      }

      case "prefer": {
        const variantId = resolve.variantId();
        if (!variantId) {
          return { kind: "needs_input", missingInputs: ["variantId"], message: "请先选择一个生成版本。" };
        }
        if (!isCanonicalVariantId(variantId)) {
          return { kind: "needs_input", missingInputs: ["variantId"], message: "我需要先确认你指的是哪个版本，请从版本列表中选择。" };
        }
        return { kind: "needs_input", missingInputs: [], message: "请说明你的偏好方向（例如：更量化、更保守、更简洁），我会据此调整。" };
      }

      case "confirm_metric":
      case "revise_more_conservative":
      case "revise_more_quantified":
        return { kind: "needs_input", missingInputs: [], message: "该操作暂未完整实现，请通过对话方式进行操作。" };

      default:
        return { kind: "unsupported" };
    }
  }
}

function explicitStep(agentName: AgentName, toolName: string, args: Record<string, unknown>, summary: string): PlanStep {
  return {
    id: `step-${randomUUID()}`,
    agentName,
    toolName,
    arguments: args,
    summary,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
