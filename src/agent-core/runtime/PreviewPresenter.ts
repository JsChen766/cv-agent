import { sanitizeExperiencePatch } from "../security/ToolPatchSanitizer.js";
import type { CopilotLocale } from "../../copilot/locale.js";

export function previewFor(toolName: string, args: Record<string, unknown>) {
  if (toolName === "save_experience_from_text") {
    return undefined;
  }
  if (toolName === "save_jd_from_text") {
    const rawText = stringValue(args.text) ?? stringValue(args.jdText) ?? stringValue(args.rawText);
    if (!rawText) return undefined;
    const title = stringValue(args.title);
    const company = stringValue(args.company);
    const targetRole = stringValue(args.targetRole) ?? title;
    const requirements = extractJDRequirements(rawText);
    const jdDraft = {
      rawText,
      title,
      company,
      targetRole,
      requirements,
      preview: rawText.slice(0, 300),
    };
    return {
      after: { jdDraft },
      jdDraft,
    };
  }
  if (toolName === "update_experience") {
    const patch = sanitizeExperiencePatch(args.patch);
    return { after: { experienceId: args.experienceId, contentPreview: typeof args.content === "string" ? args.content.slice(0, 200) : undefined, patchKeys: Object.keys(patch).slice(0, 10) } };
  }
  if (toolName === "delete_experience") return { before: args };
  if (toolName === "export_resume") return { after: args };
  return undefined;
}

export function confirmationSummary(toolName: string, locale: CopilotLocale, args?: Record<string, unknown>): string {
  if (toolName === "save_jd_from_text") return "请确认是否将这份 JD 保存到 JD 库。";
  if (toolName === "generate_resume_from_jd") {
    if (locale === "zh-CN") {
      const jdSaved = Boolean(args?.jdSaved) || Boolean(stringValue(args?.jdId));
      return jdSaved ? "JD 已保存，现在确认生成简历。" : "我已准备好基于这份 JD 生成简历版本，请确认后开始。";
    }
    return "I am ready to generate resume variants from this JD. Please confirm to start.";
  }
  if (locale === "zh-CN") {
    if (toolName === "save_experience_from_text") return "已准备好一条经历草稿，请确认后写入经历库。";
    if (toolName === "update_experience") return "请确认是否更新这段经历。";
    if (toolName === "delete_experience") return "请确认是否删除这段经历。";
    if (toolName === "export_resume") return "请确认是否创建这份简历导出。";
    if (toolName === "accept_generation_variant") return "请确认是否将此版本保存到简历库。";
    return `请确认是否执行 ${toolName}。`;
  }
  if (toolName === "save_experience_from_text") return "Please confirm saving this experience to your library.";
  if (toolName === "update_experience") return "Please confirm updating this experience.";
  if (toolName === "delete_experience") return "Please confirm deleting this experience.";
  if (toolName === "export_resume") return "Please confirm creating this resume export.";
  if (toolName === "accept_generation_variant") return "Please confirm saving this variant to your resume.";
  return `Please confirm ${toolName}.`;
}

export function confirmationTitle(toolName: string, locale: CopilotLocale, fallback?: string): string {
  if (toolName === "save_jd_from_text") return "保存 JD 到 JD 库";
  if (toolName === "save_experience_from_text") return locale === "zh-CN" ? "保存经历到经历库" : "Save experience";
  return fallback && fallback.trim().length > 0 ? fallback : toolName.replace(/_/g, " ");
}

export function extractJDRequirements(jdText: string): string[] {
  const lines = jdText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const requirementLines = lines.filter((line) => /要求|职责|技能|任职|资格|requirement|responsibilit|qualif|skill/i.test(line));
  const source = requirementLines.length > 0 ? requirementLines : lines;
  return source.slice(0, 8).map((line) => line.slice(0, 120));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
