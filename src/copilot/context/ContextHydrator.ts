import type { AgentContext } from "../../agent-core/runtime/AgentContext.js";
import type { CopilotWorkspace } from "../types.js";
import { ContextResolver } from "./ContextResolver.js";

export class ContextHydrator {
  public constructor(private readonly resolver = new ContextResolver()) {}

  public hydrate(
    toolName: string,
    args: Record<string, unknown>,
    context: AgentContext,
    workspace: CopilotWorkspace | null,
  ): Record<string, unknown> {
    const hydrated = { ...args };
    const runContext = {
      clientState: context.clientState,
      activeAssetContext: context.activeAssetContext,
      userAssetContext: context.userAssetContext,
      productContext: context.productContext,
      userMessage: context.userMessage,
      requestJDText: typeof context.productContext.requestJDText === "string" ? context.productContext.requestJDText : undefined,
    };

    if (toolName === "get_experience") {
      const experience = this.resolver.resolveExperience(runContext, workspace, hydrated);
      hydrated.id = experience.id ?? stringValue(hydrated.id);
    }
    if (toolName === "update_experience") {
      const experience = this.resolver.resolveExperience(runContext, workspace, hydrated);
      hydrated.experienceId = experience.id ?? stringValue(hydrated.experienceId);
      hydrated.content = stringValue(hydrated.content) ?? experience.text;
    }
    if (toolName === "get_jd") {
      const jd = this.resolver.resolveJD(runContext, workspace, hydrated);
      hydrated.id = jd.id ?? stringValue(hydrated.id);
    }
    if (toolName === "save_jd_from_text" || toolName === "prepare_save_jd_from_text") {
      const jd = this.resolver.resolveJD(runContext, workspace, hydrated);
      hydrated.text = jd.text ?? stringValue(hydrated.text);
      hydrated.targetRole = jd.targetRole ?? stringValue(hydrated.targetRole);
    }
    if (toolName === "generate_resume_from_jd") {
      const jd = this.resolver.resolveJD(runContext, workspace, hydrated);
      hydrated.jdId = jd.id ?? stringValue(hydrated.jdId);
      hydrated.jdText = jd.text ?? stringValue(hydrated.jdText);
      hydrated.targetRole = jd.targetRole ?? stringValue(hydrated.targetRole);
    }
    if (toolName === "get_resume") {
      const resume = this.resolver.resolveResume(runContext, workspace, hydrated);
      hydrated.id = resume.id ?? stringValue(hydrated.id);
    }
    if (toolName === "revise_resume_item") {
      const item = this.resolver.resolveResumeItem(runContext, workspace, hydrated);
      hydrated.resumeItemId = item.id ?? stringValue(hydrated.resumeItemId);
      hydrated.instruction = stringValue(hydrated.instruction) ?? item.text;
    }
    if (toolName === "export_resume" || toolName === "prepare_export_resume") {
      const resume = this.resolver.resolveResume(runContext, workspace, hydrated);
      hydrated.resumeId = resume.id ?? stringValue(hydrated.resumeId);
    }
    if (toolName === "show_evidence") {
      const variant = this.resolver.resolveVariant(runContext, workspace, hydrated);
      hydrated.id = variant.id ?? stringValue(hydrated.id);
      hydrated.variantId = variant.id ?? stringValue(hydrated.variantId);
      hydrated.generationId = stringValue(hydrated.generationId) ?? workspace?.productGenerationId ?? undefined;
    }
    if (toolName === "accept_generation_variant") {
      hydrated.generationId = stringValue(hydrated.generationId) ?? workspace?.productGenerationId ?? undefined;
      hydrated.variantId =
        stringValue(hydrated.variantId)
        ?? stringValue(hydrated.id)
        ?? context.clientState?.activeVariantId
        ?? workspace?.active?.variantId
        ?? workspace?.activeVariantId
        ?? undefined;
      hydrated.resumeId =
        stringValue(hydrated.resumeId)
        ?? context.clientState?.activeResumeId
        ?? workspace?.active?.resumeId
        ?? workspace?.resumeId
        ?? context.activeAssetContext?.activeResume?.id
        ?? undefined;
    }
    return hydrated;
  }
}

export function toolNeedsInputMessage(toolName: string, locale: string | undefined): string {
  const en = locale === "en";
  if (toolName === "get_experience" || toolName === "update_experience") {
    return en ? "Please select an experience first, or open the experience detail page before asking me to improve it." : "请先选择一条经历，或打开经历详情后再让我优化。";
  }
  if (toolName === "generate_resume_from_jd" || toolName === "save_jd_from_text" || toolName === "prepare_save_jd_from_text") {
    return en ? "Please select or paste a JD first." : "请先选择或粘贴一份 JD。";
  }
  if (toolName === "revise_resume_item") {
    return en ? "Please select a resume item first." : "请先选择一条简历内容，再让我优化。";
  }
  if (toolName === "export_resume" || toolName === "prepare_export_resume") {
    return en ? "Please select a resume first." : "请先选择一份简历。";
  }
  if (toolName === "get_jd") {
    return en ? "Please select or paste a JD first." : "请先选择或粘贴一份 JD。";
  }
  if (toolName === "get_resume") {
    return en ? "Please select a resume first." : "请先选择一份简历。";
  }
  if (toolName === "show_evidence") {
    return en ? "Please select a generation version or evidence item first." : "请先选择一个生成版本或证据项。";
  }
  if (toolName === "accept_generation_variant") {
    return en ? "Please open a generation result first, or regenerate resume versions." : "请先打开一次生成结果，或重新生成简历版本。";
  }
  return en ? "I need one more piece of information before continuing." : "还需要补充一项信息后我才能继续。";
}

export function toolNeedsInputMessageForFields(toolName: string, missingFields: string[], locale: string | undefined): string {
  const en = locale === "en";
  if (toolName === "accept_generation_variant") {
    const missingGen = missingFields.includes("generationId");
    const missingVar = missingFields.includes("variantId");
    if (missingGen && missingVar) {
      return en
        ? "Please open a generation result and select a variant first."
        : "请先打开生成结果，并选择一个要保存的版本。";
    }
    if (missingGen) {
      return en
        ? "Please open a generation result first, or regenerate resume versions."
        : "请先打开一次生成结果，或重新生成简历版本。";
    }
    if (missingVar) {
      return en
        ? "Please select a generated variant first."
        : "请先选择一个生成版本。";
    }
  }
  return toolNeedsInputMessage(toolName, locale);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
