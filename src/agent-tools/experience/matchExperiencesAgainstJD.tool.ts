import { z } from "zod";
import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import type { ModelClientChatRequest } from "../../agent-core/model/types.js";
import { ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";
import { isDeterministicFallbackAllowed, llmNotAvailableResult } from "../../product/deterministicFallbackGuard.js";

const BatchMatchInputSchema = z.object({
  jdId: z.string().optional(),
  jdText: z.string().optional(),
  limit: z.number().int().positive().max(30).optional(),
}).passthrough();

// ── Return types ───────────────────────────────────────────────

type MatchResult = {
  experienceId: string;
  title: string;
  category?: string;
  role?: string;
  organization?: string;
  dateRange?: string;
  matchScore: number;
  matchLevel: "high" | "medium" | "low";
  matchedRequirements: string[];
  missingRequirements: string[];
  evidenceFromExperience: string;
  reason: string;
  suggestedUsage: string;
  rewriteSuggestion: string;
};

type MatchTopResults = {
  high: MatchResult[];
  medium: MatchResult[];
  low: MatchResult[];
};

// ── Thresholds ─────────────────────────────────────────────────
const HIGH_THRESHOLD = 0.75;
const MEDIUM_THRESHOLD = 0.45;

function classifyLevel(score: number): "high" | "medium" | "low" {
  if (score >= HIGH_THRESHOLD) return "high";
  if (score >= MEDIUM_THRESHOLD) return "medium";
  return "low";
}

// ── Tool definition ────────────────────────────────────────────

export function matchExperiencesAgainstJDTool(): ToolDefinition {
  return {
    name: "match_experiences_against_jd",
    description: "Match ALL experiences in the library against a JD and return scored, sorted results. Use this when the user asks which experiences fit a JD.",
    ownerAgent: "experience_receiver",
    inputSchema: BatchMatchInputSchema,
    outputSchema: ToolResultSchema,
    mutability: "read",
    requiresConfirmation: false,
    riskLevel: "low",
    execute: async (input, context) => {
      const limit = typeof input.limit === "number" ? input.limit : 30;

      // Resolve JD text
      const jdText = typeof input.jdText === "string" ? input.jdText.trim() : "";
      const jdId = typeof input.jdId === "string" ? input.jdId : undefined;
      const jd = jdId ? await context.kernel.productServices.jdService.getJD(context.userId, jdId) : null;
      const targetText = jdText || jd?.rawText || "";
      if (!targetText) {
        return {
          status: "needs_input",
          message: "请提供 JD 文本或选择一份 JD，我才能为你匹配经历。",
          visibility: "error_user_visible",
          actionResult: {
            actionType: "match_experiences_against_jd",
            status: "needs_input",
            missingInputs: ["jdId", "jdText"],
          },
        };
      }

      // List experiences
      const experiences = await context.kernel.productServices.experienceService.listExperiences(
        context.userId,
        { limit, status: "active" },
      );
      if (experiences.length === 0) {
        return emptyResult(jd?.id ?? jdId);
      }

      // ── Load revision content for each experience ──────────
      const enriched = await enrichWithContent(context, experiences);

      // ── Primary path: LLM matching ─────────────────────────
      const modelClient = context.kernel.frontDeskModelClient;
      let llmFailed = false;
      let matches: MatchResult[] | null = null;
      if (modelClient) {
        try {
          matches = await llmBatchMatch(modelClient, enriched, targetText);
        } catch {
          llmFailed = true;
        }
        // If LLM returned empty results, treat as failure and fall through to keyword
        if (!llmFailed && (!matches || matches.length === 0)) {
          llmFailed = true;
        }
        if (!llmFailed && matches && matches.length > 0) {
          return buildSuccessResponse(matches, enriched.length, jd?.id ?? jdId, targetText, "llm");
        }
        // LLM produced nothing useful — fall through to keyword if allowed
        if (!isDeterministicFallbackAllowed()) {
          return llmNotAvailableResult("match_experiences_against_jd",
            "当前 AI 模型服务暂时不可用，无法进行智能 JD 匹配。请稍后重试。");
        }
      } else if (!isDeterministicFallbackAllowed()) {
        return llmNotAvailableResult("match_experiences_against_jd",
          "当前 AI 模型服务未配置，无法进行智能 JD 匹配。");
      }

      // ── Fallback: keyword-based matching ──────────────────
      const kwMatches = keywordBatchMatch(enriched, targetText);
      return buildSuccessResponse(kwMatches, enriched.length, jd?.id ?? jdId, targetText, "keyword");
    },
  };
}

// ── Enrichment: load revision content ──────────────────────────

type EnrichedExperience = {
  id: string;
  title: string;
  category?: string;
  role?: string;
  organization?: string;
  startDate?: string;
  endDate?: string;
  content: string;
  tags: string[];
  structured?: Record<string, unknown>;
};

async function enrichWithContent(
  context: { userId: string; kernel: { productServices: { experienceService: { listRevisions: (userId: string, experienceId: string) => Promise<Array<{ id: string; content: string; structured?: Record<string, unknown> }>> } } } },
  experiences: Array<{ id: string; title: string; organization?: string; role?: string; startDate?: string; endDate?: string; currentRevisionId?: string; category?: string; tags?: string[] }>,
): Promise<EnrichedExperience[]> {
  const results: EnrichedExperience[] = [];
  for (const exp of experiences) {
    let content = "";
    let structured: Record<string, unknown> | undefined;
    try {
      const revisions = await context.kernel.productServices.experienceService.listRevisions(context.userId, exp.id);
      const current = exp.currentRevisionId
        ? revisions.find((r) => r.id === exp.currentRevisionId)
        : revisions.at(0);
      content = current?.content ?? "";
      structured = current?.structured;
    } catch {
      // ignore — content will be empty
    }
    results.push({
      id: exp.id,
      title: exp.title,
      category: exp.category,
      role: exp.role,
      organization: exp.organization,
      startDate: exp.startDate,
      endDate: exp.endDate,
      content,
      tags: exp.tags ?? [],
      structured,
    });
  }
  return results;
}

// ── LLM batch matching ─────────────────────────────────────────

async function llmBatchMatch(
  modelClient: import("../../agent-core/model/ModelClient.js").ModelClient,
  experiences: EnrichedExperience[],
  jdText: string,
): Promise<MatchResult[]> {
  // Build rich experience summaries including content
  const expList = experiences.slice(0, 20).map((exp, i) => {
    const parts: string[] = [];
    parts.push(`[${i + 1}] ${exp.title}`);
    if (exp.organization) parts.push(` @ ${exp.organization}`);
    if (exp.role) parts.push(` as ${exp.role}`);
    if (exp.category) parts.push(` (${exp.category})`);
    if (exp.tags.length > 0) parts.push(` tags: ${exp.tags.join(", ")}`);
    // Include content preview for LLM to match against
    const contentPreview = exp.content.slice(0, 400);
    if (contentPreview) parts.push(` content: ${contentPreview}`);
    return parts.join("\n");
  }).join("\n\n");

  const systemPrompt = [
    "You are a resume-to-JD matching assistant. Score each experience against the JD.",
    "",
    "For each experience, return a JSON object with:",
    "- experienceIndex: number matching the list index",
    "- matchScore: 0.0-1.0",
    "- matchLevel: \"high\" | \"medium\" | \"low\"",
    "- matchedRequirements: JD requirements/skills this experience fulfills (array of strings)",
    "- missingRequirements: JD requirements this experience lacks (array of strings)",
    "- evidenceFromExperience: specific text from the experience that supports the match (1-2 sentences)",
    "- reason: one-sentence justification in Chinese",
    "- suggestedUsage: how this experience should be positioned on a resume for this JD (in Chinese)",
    "- rewriteSuggestion: a concrete suggestion for rewriting this experience to better fit the JD (in Chinese)",
    "",
    "Scoring rules:",
    "- Score based on keyword overlap, role alignment, tech stack match, domain relevance, and seniority match.",
    "- Match against the FULL experience content, not just the title.",
    "- Even if an experience is not a perfect match, give partial credit for transferable skills.",
    "- High >= 0.75, Medium >= 0.45, Low < 0.45.",
    "- Be fair and nuanced: every experience has some value.",
    "",
    "Output ONLY a valid JSON array. No markdown, no explanation.",
  ].join("\n");

  const userPrompt = [
    "JD:",
    jdText.slice(0, 4000),
    "",
    "Experiences (with content):",
    expList || "No experiences available.",
    "",
    "Return a JSON array with one object per experience (same order as listed).",
  ].join("\n");

  const chatRequest: ModelClientChatRequest = {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.2,
    maxTokens: 4096,
    responseFormat: "json",
  };
  const response = await modelClient.chat(chatRequest);

  const parsed = parseJsonArray(response.content);
  if (!Array.isArray(parsed)) throw new Error("Invalid LLM response");

  return parsed.map((item: Record<string, unknown>, i: number) => {
    const idx = typeof item.experienceIndex === "number" ? item.experienceIndex - 1 : i;
    const exp = experiences[idx] ?? experiences[i];
    const score = typeof item.matchScore === "number" ? clampScore(item.matchScore) : 0;
    return {
      experienceId: exp?.id ?? `unknown-${i}`,
      title: exp?.title ?? "Unknown",
      category: exp?.category,
      role: exp?.role,
      organization: exp?.organization,
      dateRange: formatDateRange(exp?.startDate, exp?.endDate),
      matchScore: score,
      matchLevel: (typeof item.matchLevel === "string" && ["high", "medium", "low"].includes(item.matchLevel as string))
        ? (item.matchLevel as "high" | "medium" | "low")
        : classifyLevel(score),
      matchedRequirements: stringArray(item.matchedRequirements),
      missingRequirements: stringArray(item.missingRequirements),
      evidenceFromExperience: typeof item.evidenceFromExperience === "string" ? item.evidenceFromExperience : "",
      reason: typeof item.reason === "string" ? item.reason : buildDefaultReason(score),
      suggestedUsage: typeof item.suggestedUsage === "string" ? item.suggestedUsage : "可用于简历中相关经历部分。",
      rewriteSuggestion: typeof item.rewriteSuggestion === "string" ? item.rewriteSuggestion : "",
    };
  });
}

// ── Keyword-based fallback ─────────────────────────────────────

function keywordBatchMatch(
  experiences: EnrichedExperience[],
  jdText: string,
): MatchResult[] {
  const jdLower = jdText.toLowerCase();
  const jdWords = uniqueWords(jdLower);

  return experiences.map((exp) => {
    // Match against content too, not just title
    const expText = [
      exp.title,
      exp.organization ?? "",
      exp.role ?? "",
      exp.content.slice(0, 1000),
      ...exp.tags,
    ].join(" ").toLowerCase();

    const matched = jdWords.filter((w) => expText.includes(w)).slice(0, 30);
    const score = jdWords.length > 0
      ? clampScore(Number((matched.length / Math.min(jdWords.length, 60)).toFixed(2)))
      : 0;

    const level = classifyLevel(score);
    const matchedSet = new Set(matched);
    // Separate into requirements matched vs keywords
    const matchedReqs = matched.slice(0, 8);
    const missingReqs = jdWords.filter((w) => !matchedSet.has(w)).slice(0, 5);

    return {
      experienceId: exp.id,
      title: exp.title,
      category: exp.category,
      role: exp.role,
      organization: exp.organization,
      dateRange: formatDateRange(exp.startDate, exp.endDate),
      matchScore: score,
      matchLevel: level,
      matchedRequirements: matchedReqs.map((w) => `关键词: ${w}`),
      missingRequirements: missingReqs.map((w) => `未匹配: ${w}`),
      evidenceFromExperience: matchedReqs.length > 0
        ? `匹配关键词: ${matchedReqs.join(", ")}`
        : "未发现明显关键词匹配。",
      reason: level === "high"
        ? "关键词高度匹配"
        : level === "medium"
          ? "存在部分关键词匹配"
          : "关键词匹配度较低，建议补充更多 JD 相关技能描述到经历正文中。",
      suggestedUsage: level !== "low"
        ? "可作为简历素材，建议进一步人工核对。"
        : "需要大幅改写或补充相关内容后才能用于该 JD。",
      rewriteSuggestion: level === "low"
        ? `建议在经历正文中补充与以下 JD 关键词相关的内容: ${missingReqs.slice(0, 3).join(", ")}`
        : "",
    };
  });
}

// ── Response builder ───────────────────────────────────────────

function buildSuccessResponse(
  matches: MatchResult[],
  totalExperienceCount: number,
  jdId: string | undefined,
  jdText: string,
  matchMethod: string,
) {
  // Sort by score descending
  const sorted = [...matches].sort((a, b) => b.matchScore - a.matchScore);

  const high = sorted.filter((m) => m.matchLevel === "high");
  const medium = sorted.filter((m) => m.matchLevel === "medium");
  const low = sorted.filter((m) => m.matchLevel === "low");

  const topResults: MatchTopResults = { high, medium, low };
  const candidateCount = medium.length + low.length;
  const jdSummary = summarizeJD(jdText);
  const summary =
    high.length > 0
      ? `已匹配 ${totalExperienceCount} 条经历，其中 ${high.length} 条为高匹配。`
      : medium.length > 0
        ? `已匹配 ${totalExperienceCount} 条经历，暂无高匹配经历，但 ${medium.length} 条可作为候选素材。`
        : `已匹配 ${totalExperienceCount} 条经历，暂无高匹配经历，但 ${candidateCount} 条可作为候选素材。`;

  let message: string;
  if (high.length > 0) {
    message = `我已根据这份 JD 匹配了经历库，其中 ${high.length} 条为高匹配。`;
  } else if (medium.length > 0) {
    message = `我已根据这份 JD 匹配了经历库，暂无高匹配经历，但有 ${medium.length} 条可作为候选素材。`;
  } else {
    message = `我已根据这份 JD 匹配了经历库，暂无高匹配经历，但有 ${candidateCount} 条可作为候选素材。`;
  }

  return {
    status: "success" as const,
    message,
    data: {
      totalCount: totalExperienceCount,
      totalExperienceCount,
      matchMethod,
      jdId,
      transientJD: !jdId,
      jdText: jdText.slice(0, 8000),
      jdSummary,
      summary,
      highMatches: high.length,
      mediumMatches: medium.length,
      lowMatches: low.length,
      jdPreview: jdText.slice(0, 300),
      scoreDistribution: {
        high: high.length,
        medium: medium.length,
        low: low.length,
      },
      topResults,
      // Legacy flat list for backward compat
      matches: sorted,
      count: sorted.length,
    },
    visibility: "user_summary" as const,
    workspacePatch: { activePanel: "jd_matching" },
    actionResult: {
      actionType: "match_experiences_against_jd" as const,
      status: "success" as const,
      metadata: {
        matchCount: sorted.length,
        matchMethod,
        jdId,
        highCount: high.length,
        mediumCount: medium.length,
        lowCount: low.length,
        summary,
      },
    },
  };
}

function emptyResult(jdId: string | undefined) {
  return {
    status: "success" as const,
    message: "我已根据这份 JD 匹配了经历库，但你的经历库目前为空。",
    data: {
      totalCount: 0,
      totalExperienceCount: 0,
      count: 0,
      matches: [],
      topResults: { high: [], medium: [], low: [] },
      jdId,
      transientJD: !jdId,
      summary: "已匹配 0 条经历，当前经历库为空。",
      highMatches: 0,
      mediumMatches: 0,
      lowMatches: 0,
      scoreDistribution: { high: 0, medium: 0, low: 0 },
    },
    visibility: "user_summary" as const,
  };
}

// ── Helpers ────────────────────────────────────────────────────

function formatDateRange(startDate?: string, endDate?: string): string | undefined {
  const start = typeof startDate === "string" ? startDate.trim() : "";
  const end = typeof endDate === "string" ? endDate.trim() : "";
  if (!start && !end) return undefined;
  if (!start) return end;
  if (!end) return `${start} - Present`;
  return `${start} - ${end}`;
}

function summarizeJD(jdText: string): { title?: string; company?: string; targetRole?: string; preview: string } {
  const preview = jdText.slice(0, 300);
  const lines = jdText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const firstLine = lines[0];
  const title = firstLine && firstLine.length <= 80 ? firstLine : undefined;
  return {
    title,
    targetRole: title,
    preview,
  };
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

function buildDefaultReason(score: number): string {
  if (score >= HIGH_THRESHOLD) return "该经历与 JD 高度匹配。";
  if (score >= MEDIUM_THRESHOLD) return "该经历与 JD 部分匹配。";
  return "该经历与 JD 匹配度较低，建议补充相关内容。";
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function uniqueWords(text: string): string[] {
  const words = text
    .split(/[^a-z0-9\u4e00-\u9fa5]+/i)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
  return Array.from(new Set(words)).slice(0, 150);
}

function parseJsonArray(content: string): unknown {
  const trimmed = content.trim();
  const jsonBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const json = jsonBlock?.[1] ?? trimmed;
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === "object" && parsed !== null) {
      for (const value of Object.values(parsed as Record<string, unknown>)) {
        if (Array.isArray(value)) return value;
      }
    }
    return [];
  } catch {
    const bracketStart = json.indexOf("[");
    const bracketEnd = json.lastIndexOf("]");
    if (bracketStart >= 0 && bracketEnd > bracketStart) {
      try { return JSON.parse(json.slice(bracketStart, bracketEnd + 1)); } catch { /* ignore */ }
    }
    return [];
  }
}
