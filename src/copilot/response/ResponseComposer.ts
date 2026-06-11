import type { PendingAction } from "../../agent-core/confirmation/PendingAction.js";
import type { AgentContext } from "../../agent-core/runtime/AgentContext.js";
import type { CriticReview } from "../../agent-core/validation/AgentOutputSchemas.js";
import type { ToolResult } from "../../agent-core/tools/ToolResult.js";
import type { CopilotLocale } from "../locale.js";
import type { CopilotWorkspace, ProductAction } from "../types.js";
import type { FrontDeskHandoff } from "../handoff/FrontDeskHandoff.js";
import type { CopilotTask } from "../tasks/CopilotTask.js";
import { isBlockedToolLog } from "./ProductReplyTemplates.js";

export type ResponseComposerInput = {
  locale: CopilotLocale;
  userMessage: string;
  frontDeskHandoff?: FrontDeskHandoff;
  workspace: CopilotWorkspace | null;
  toolResults: ToolResult[];
  pendingActions: PendingAction[];
  criticReview?: CriticReview;
  currentTask?: CopilotTask;
  suggestedTasks?: CopilotTask[];
  context: AgentContext;
  fallbackText?: string;
};

export type ResponseComposerOutput = {
  assistantText: string;
  nextActions?: ProductAction[];
  systemNotices?: string[];
};

export class ResponseComposer {
  public compose(input: ResponseComposerInput): ResponseComposerOutput {
    const en = input.locale === "en";
    const actionable = input.toolResults.find((result) => (
      result.actionResult?.status === "needs_confirmation"
      || (result.visibility === "action_required" && result.actionResult?.status === "needs_confirmation")
    ));
    if (actionable) {
      return { assistantText: confirmationText(input, actionable) };
    }

    const needsInput = input.toolResults.find((result) => result.status === "needs_input");
    if (needsInput) {
      return { assistantText: visibleMessage(needsInput) ?? (en ? "I need one more detail before continuing." : "还需要补充一点信息后我才能继续。") };
    }

    const failed = input.toolResults.find((result) => result.status === "failed" && result.visibility === "error_user_visible");
    if (failed) {
      return { assistantText: visibleMessage(failed) ?? (en ? "This operation did not complete." : "这次操作没有完成。") };
    }

    const fallback = input.fallbackText?.trim();

    const accepted = input.toolResults.find((result) => result.actionResult?.actionType === "accept_generation_variant" && result.status === "success");
    if (accepted) {
      const acceptedMessage = visibleMessage(accepted);
      const metadata = accepted.actionResult?.metadata as Record<string, unknown> | undefined;
      const resumeId = stringValue(metadata?.resumeId);
      return {
        assistantText: acceptedMessage ?? (en
          ? "The variant has been saved to your resume. You can now export it."
          : "已将选中的版本保存到简历，你可以导出文件了。"),
        nextActions: resumeId ? [{
          id: "export_resume",
          type: "export_resume" as const,
          label: en ? "Export resume" : "导出简历",
          description: en ? "Download your resume as HTML or PDF." : "将简历导出为 HTML 或 PDF 文件。",
          payload: { resumeId },
          primary: true,
        }] : undefined,
      };
    }

    const generated = input.toolResults.find((result) => result.actionResult?.actionType === "generate_resume_from_jd" || hasVariants(result));
    const exported = input.toolResults.find((result) => result.actionResult?.actionType === "export_resume" && result.status === "success");
    if (exported) {
      const exportMessage = visibleMessage(exported);
      if (exportMessage) return { assistantText: exportMessage };
      return {
        assistantText: en
          ? "The resume export job has been created. A download button will appear when the file is ready."
          : "简历导出任务已创建，文件生成完成后可下载。",
      };
    }

    if (generated) {
      if (isGeneratingResume(generated)) {
        return {
          assistantText: en
            ? "Resume generation has started. I will update the result when the background job completes."
            : "已开始生成简历版本，后台任务完成后会更新结果。",
        };
      }
      const count = variantCount(generated) ?? input.workspace?.variants?.length ?? 0;
      return {
        assistantText: en
          ? `Generated ${count || "multiple"} resume variants from the JD. Choose one variant to save as a resume, then you can export a file.`
          : `已基于 JD 生成 ${count || "多个"} 个简历版本。请选择一个版本保存为简历，之后可以导出文件。`,
      };
    }

    const jdMatch = input.toolResults.find((result) => result.actionResult?.actionType === "match_experiences_against_jd");
    if (jdMatch) {
      const matchData = matchResultsData(jdMatch);
      return {
        assistantText: shortMatchSummary(matchData) ?? "I have matched your experiences against this JD.",
      };
    }

    const listedExperiences = input.toolResults.find((result) => hasDataCount(result) && result.workspacePatch?.activePanel === "experience_library");
    if (listedExperiences) {
      const count = dataCount(listedExperiences) ?? 0;
      return {
        assistantText: en
          ? (count === 0 ? "Your experience library is currently empty." : `I found ${count} item(s) in your experience library.`)
          : (count === 0 ? "你的经历库目前是空的。" : `我在经历库里看到了 ${count} 条经历。`),
      };
    }

    if (input.context.loopState?.stopReason === "max_steps") {
      return {
        assistantText: en
          ? "I completed the available runtime steps. Tell me what you want to adjust next if we should continue."
          : "我已完成当前可用的运行步骤。如需继续，请告诉我下一步要调整什么。",
      };
    }

    if (input.frontDeskHandoff?.intent === "jd.intake") {
      const role = input.frontDeskHandoff.extracted.targetRole ?? input.frontDeskHandoff.extracted.title ?? "岗位";
      return {
        assistantText: en
          ? `I recognized this as a JD for ${role}. You can ask me to save it, analyze it, or generate a tailored resume from it.`
          : `我已识别到这是一份【${role}】相关 JD。你可以让我保存到 JD 库、分析岗位要求，或基于它生成定制简历。`,
      };
    }

    if (input.criticReview?.verdict === "pass" && fallback && !isBlockedToolLog(fallback)) {
      return { assistantText: fallback };
    }

    const visibleSummary = input.toolResults
      .map(visibleMessage)
      .find((message): message is string => typeof message === "string" && !isBlockedToolLog(message));
    if (visibleSummary) return { assistantText: visibleSummary };

    if (input.criticReview?.userVisibleSummary) return { assistantText: input.criticReview.userVisibleSummary };

    if (fallback && !isBlockedToolLog(fallback)) return { assistantText: fallback };

    const hasFilteredInternalResults = input.toolResults.some((result) =>
      result.visibility === "internal"
      && result.data !== undefined
      && typeof result.data === "object"
      && result.data !== null
      && Object.keys(result.data).length > 0
    );
    if (fallback && hasFilteredInternalResults && fallback.trim() && !isBlockedToolLog(fallback)) {
      return { assistantText: fallback };
    }

    const hasSubstantiveResults = input.toolResults.some((result) =>
      result.data !== undefined
      && typeof result.data === "object"
      && result.data !== null
      && Object.keys(result.data).length > 0
    );
    if (hasSubstantiveResults && !fallback?.trim()) {
      return {
        assistantText: en
          ? "I've found some results. You can explore them in the workspace."
          : "已完成处理，结果可在工作台查看。",
      };
    }

    return { assistantText: en ? "Done." : "已完成。" };
  }
}

function confirmationText(input: ResponseComposerInput, result: ToolResult): string {
  const en = input.locale === "en";
  const actionType = typeof result.actionResult?.actionType === "string" ? result.actionResult.actionType : undefined;
  if (actionType === "update_experience") {
    return en
      ? "I prepared a revised version of this experience. Please confirm before I write it as a new revision."
      : "我已准备好这条经历的改写版本，请确认后写入经历库 revision。";
  }
  if (actionType === "generate_resume_from_jd") {
    return en
      ? "I am ready to generate resume variants from this JD. Please confirm to start."
      : "我已准备好基于这份 JD 生成简历版本，请确认后开始。";
  }
  if (actionType === "accept_generation_variant") {
    return en
      ? "I will save this variant to your resume. Please confirm."
      : "我将把这个版本保存到你的简历中，请确认。";
  }
  if (actionType === "save_jd_from_text") {
    return en
      ? "I prepared this JD for saving. Please confirm before it is added to your JD library."
      : "我已准备好保存这份 JD，请确认后写入 JD 库。";
  }
  return visibleMessage(result) ?? (en ? "Please confirm before I continue." : "请确认后我再继续。");
}

function visibleMessage(result: ToolResult): string | undefined {
  if (!result.message || result.visibility === "internal" || isBlockedToolLog(result.message)) return undefined;
  return result.message;
}

function hasVariants(result: ToolResult): boolean {
  return typeof result.data === "object" && result.data !== null && Array.isArray((result.data as { variants?: unknown[] }).variants);
}

function isGeneratingResume(result: ToolResult): boolean {
  const metadata = result.actionResult?.metadata;
  return typeof metadata === "object" && metadata !== null && (metadata as Record<string, unknown>).generating === true;
}

function hasDataCount(result: ToolResult): boolean {
  return dataCount(result) !== undefined;
}

function dataCount(result: ToolResult): number | undefined {
  if (typeof result.data === "object" && result.data !== null) {
    const count = (result.data as { count?: unknown }).count;
    if (typeof count === "number") return count;
  }
  return undefined;
}

function matchResultsData(result: ToolResult): Record<string, unknown> {
  return typeof result.data === "object" && result.data !== null
    ? result.data as Record<string, unknown>
    : {};
}

function shortMatchSummary(data: Record<string, unknown>): string | undefined {
  const summary = stringValue(data.summary);
  if (summary) return summary;
  const total = numberValue(data.totalExperienceCount) ?? numberValue(data.totalCount);
  const high = numberValue(data.highMatches) ?? 0;
  const medium = numberValue(data.mediumMatches) ?? 0;
  const low = numberValue(data.lowMatches) ?? 0;
  const candidate = medium + low;
  if (typeof total !== "number") return undefined;
  if (high > 0) return `我已根据这份 JD 匹配了经历库，其中 ${high} 条为高匹配。`;
  return `我已根据这份 JD 匹配了经历库，暂无高匹配经历，但有 ${candidate} 条可作为候选素材。`;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function variantCount(result: ToolResult): number | undefined {
  if (typeof result.actionResult?.metadata === "object" && result.actionResult.metadata !== null) {
    const count = (result.actionResult.metadata as { variantCount?: unknown }).variantCount;
    if (typeof count === "number") return count;
  }
  if (typeof result.data === "object" && result.data !== null) {
    const variants = (result.data as { variants?: unknown[] }).variants;
    if (Array.isArray(variants)) return variants.length;
  }
  return undefined;
}
