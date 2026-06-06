import { computeJDHash } from "../../product/jdHash.js";
import type { ProductAction, ProductBlock } from "../../copilot/types.js";
import type { ToolResult } from "../tools/ToolResult.js";

export function buildProductBlocks(toolResults: ToolResult[]): ProductBlock[] {
  let experienceList: ProductBlock | null = null;
  let experienceCard: ProductBlock | null = null;
  let experienceCandidateForm: ProductBlock | null = null;
  let detailBlock: ProductBlock | null = null;
  let actionBlock: ProductBlock | null = null;
  let matchBlock: ProductBlock | null = null;

  for (const result of toolResults) {
    if (!result.data || typeof result.data !== "object") continue;
    const data = result.data as Record<string, unknown>;

    // Match results block — priority over plain lists
    if (isRecord(data.topResults) && typeof data.totalCount === "number") {
      const topResults = data.topResults as Record<string, unknown>;
      const high = (topResults.high as Array<Record<string, unknown>>) ?? [];
      const medium = (topResults.medium as Array<Record<string, unknown>>) ?? [];
      const low = (topResults.low as Array<Record<string, unknown>>) ?? [];
      const jdPreview = typeof data.jdPreview === "string" ? data.jdPreview : undefined;
      const jdSummary = isRecord(data.jdSummary) ? data.jdSummary as Record<string, unknown> : {};
      const scoreDist = isRecord(data.scoreDistribution) ? data.scoreDistribution as Record<string, unknown> : {};
      const summary = stringValue(data.summary)
        ?? `已匹配 ${typeof data.totalExperienceCount === "number" ? data.totalExperienceCount : data.totalCount} 条经历，暂无高匹配经历。`;
      const jdActions = buildJDMatchActions(data);
      const saveAction = jdActions.find((action) => action.type === "save_jd_from_text" && !action.payload?.generateAfterSave);
      const rawMatches = Array.isArray(data.matches) ? data.matches as Array<Record<string, unknown>> : [...high, ...medium, ...low];
      const sanitizedMatchResults = rawMatches.map(sanitizeMatchResult);
      matchBlock = {
        type: "experience_match_results",
        title: "JD 匹配经历推荐",
        data: sanitizeMetadataObject({
          totalExperienceCount: typeof data.totalExperienceCount === "number" ? data.totalExperienceCount : data.totalCount,
          totalCount: data.totalCount,
          highMatches: typeof data.highMatches === "number" ? data.highMatches : high.length,
          mediumMatches: typeof data.mediumMatches === "number" ? data.mediumMatches : medium.length,
          lowMatches: typeof data.lowMatches === "number" ? data.lowMatches : low.length,
          summary,
          matchMethod: data.matchMethod,
          jdSummary: sanitizeMetadataObject({
            title: jdSummary.title,
            company: jdSummary.company,
            targetRole: jdSummary.targetRole,
            preview: jdSummary.preview ?? jdPreview,
          }),
          jdPreview,
          scoreDistribution: {
            high: typeof scoreDist.high === "number" ? scoreDist.high : high.length,
            medium: typeof scoreDist.medium === "number" ? scoreDist.medium : medium.length,
            low: typeof scoreDist.low === "number" ? scoreDist.low : low.length,
          },
          topResults: {
            high: high.slice(0, 5).map(sanitizeMatchResult),
            medium: medium.slice(0, 5).map(sanitizeMatchResult),
            low: low.slice(0, 5).map(sanitizeMatchResult),
          },
          matchResults: sanitizedMatchResults,
          ...(saveAction ? { saveJDAction: saveAction } : {}),
          ...(jdActions.length ? { actions: jdActions } : {}),
          // Flat list for backward compat
          allResults: [...high, ...medium, ...low].slice(0, 10).map(sanitizeMatchResult),
        }) ?? {},
      };
      continue;
    }

    if (Array.isArray(data.items) && typeof data.count === "number") {
      experienceList = {
        type: "experience_list",
        title: "Experience library",
        data: {
          count: data.count,
          items: (data.items as Array<Record<string, unknown>>).slice(0, 3).map(sanitizeExperienceItem),
        },
      };
      continue;
    }
    if (Array.isArray(data.candidates) && isRecord(data.job) && data.formSchemaVersion === 1) {
      const candidates = (data.candidates as Array<Record<string, unknown>>).map(sanitizeImportCandidate);
      experienceCandidateForm = {
        type: "experience_candidate_form",
        title: "待确认的经历候选",
        data: sanitizeMetadataObject({
          job: data.job,
          candidates,
          formSchemaVersion: 1,
          saveMode: data.saveMode ?? "accept_candidate",
          actions: Array.isArray(data.actions) ? data.actions : defaultExperienceCandidateActions(),
        }) ?? {},
      };
      continue;
    }
    if (isRecord(data.experience)) {
      experienceCard = {
        type: "experience_card",
        title: String((data.experience as Record<string, unknown>).title ?? "Experience"),
        data: sanitizeExperienceItem(data.experience as Record<string, unknown>),
      };
      continue;
    }
    if (isRecord(data.currentRevision) || Array.isArray(data.revisions)) {
      const experience = isRecord(data.experience) ? sanitizeExperienceItem(data.experience as Record<string, unknown>) : undefined;
      detailBlock = {
        type: "experience_detail",
        title: typeof experience?.title === "string" ? experience.title : "Experience detail",
        data: sanitizeMetadataObject({
          experience,
          currentRevision: isRecord(data.currentRevision) ? sanitizeRevision(data.currentRevision as Record<string, unknown>) : undefined,
          revisionCount: Array.isArray(data.revisions) ? data.revisions.length : undefined,
        }) ?? {},
      };
      continue;
    }
    if (isRecord(result.actionResult)) {
      actionBlock = {
        type: "action_result",
        title: String((result.actionResult as Record<string, unknown>).actionType ?? "Action result"),
        data: sanitizeMetadataObject(result.actionResult as Record<string, unknown>) ?? {},
      };
    }
  }
  // Match results have highest priority — they're the most actionable
  if (matchBlock) return [matchBlock];
  if (experienceCandidateForm) return [experienceCandidateForm];
  if (experienceCard) return [experienceCard];
  if (detailBlock) return [detailBlock];
  if (experienceList) return [experienceList];
  if (actionBlock) return [actionBlock];
  return [];
}

export function sanitizeImportCandidate(item: Record<string, unknown>): Record<string, unknown> {
  return sanitizeMetadataObject({
    id: item.id,
    jobId: item.jobId,
    category: item.category,
    title: item.title,
    organization: item.organization,
    role: item.role,
    startDate: item.startDate,
    endDate: item.endDate,
    sourceDocumentId: item.sourceDocumentId,
    content: typeof item.content === "string" ? item.content.slice(0, 2000) : undefined,
    structured: isRecord(item.structured) ? item.structured : undefined,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }) ?? {};
}

function defaultExperienceCandidateActions(): ProductAction[] {
  return [
    {
      id: "save",
      type: "save_experience_candidate",
      label: "保存到经历库",
      primary: true,
    },
    {
      id: "reject",
      type: "reject_experience_candidate",
      label: "忽略",
      primary: false,
    },
  ];
}

export function sanitizeExperienceItem(item: Record<string, unknown>): Record<string, unknown> {
  return sanitizeMetadataObject({
    id: item.id,
    category: item.category,
    title: item.title,
    organization: item.organization,
    role: item.role,
    startDate: item.startDate,
    endDate: item.endDate,
    tags: item.tags,
    status: item.status,
    currentRevisionId: item.currentRevisionId,
    content: typeof item.content === "string" ? item.content.slice(0, 500) : undefined,
    structured: isRecord(item.structured) ? item.structured : undefined,
    updatedAt: item.updatedAt,
  }) ?? {};
}

export function sanitizeMatchResult(item: Record<string, unknown>): Record<string, unknown> {
  return sanitizeMetadataObject({
    experienceId: item.experienceId,
    title: item.title,
    category: item.category,
    role: item.role,
    organization: item.organization,
    dateRange: item.dateRange,
    matchScore: item.matchScore,
    matchLevel: item.matchLevel,
    reason: item.reason,
    matchedRequirements: item.matchedRequirements,
    missingRequirements: item.missingRequirements,
    evidenceFromExperience: item.evidenceFromExperience,
    suggestedUsage: item.suggestedUsage,
    rewriteSuggestion: item.rewriteSuggestion,
  }) ?? {};
}

export function sanitizeRevision(item: Record<string, unknown>): Record<string, unknown> {
  return sanitizeMetadataObject({
    id: item.id,
    source: item.source,
    content: typeof item.content === "string" ? item.content.slice(0, 800) : undefined,
    structured: isRecord(item.structured) ? item.structured : undefined,
    createdAt: item.createdAt,
  }) ?? {};
}

export function buildSaveJDAction(data: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof data.jdId === "string" && data.jdId.trim().length > 0) return undefined;
  const rawText = stringValue(data.jdText);
  if (!rawText) return undefined;
  const jdHash = computeJDHash(rawText);
  const jdSummary = isRecord(data.jdSummary) ? data.jdSummary as Record<string, unknown> : {};
  return sanitizeMetadataObject({
    id: `save-jd-${jdHash.slice(0, 12)}`,
    type: "save_jd_from_text",
    label: "保存该 JD 到 JD 库",
    primary: false,
    payload: {
      jdText: rawText,
      rawText,
      title: stringValue(jdSummary.title),
      company: stringValue(jdSummary.company),
      targetRole: stringValue(jdSummary.targetRole),
      jdHash,
    },
  });
}

export function buildJDMatchActions(data: Record<string, unknown>): ProductAction[] {
  const rawText = stringValue(data.jdText);
  const jdId = stringValue(data.jdId);
  const jdHash = rawText ? computeJDHash(rawText) : undefined;
  const jdSummary = isRecord(data.jdSummary) ? data.jdSummary as Record<string, unknown> : {};
  const title = stringValue(jdSummary.title);
  const company = stringValue(jdSummary.company);
  const targetRole = stringValue(jdSummary.targetRole);
  const basePayload = sanitizeMetadataObject({
    jdId,
    jdText: rawText,
    rawText,
    title,
    company,
    targetRole,
    jdHash,
  }) ?? {};

  const actions: ProductAction[] = [];
  if (rawText && !jdId) {
    actions.push({
      id: `save-generate-jd-${jdHash?.slice(0, 12) ?? "draft"}`,
      type: "save_jd_from_text",
      label: "保存 JD 并生成简历",
      description: "先保存到 JD 库，再基于保存后的 JD 发起简历生成。",
      primary: true,
      payload: { ...basePayload, generateAfterSave: true },
    });
  }

  if (rawText || jdId) {
    actions.push({
      id: `generate-jd-${jdId || jdHash?.slice(0, 12) || "draft"}`,
      type: "generate_from_jd",
      label: jdId ? "基于该 JD 生成简历" : "不保存 JD，直接生成简历",
      description: jdId ? "使用已保存 JD 生成简历版本。" : "不写入 JD 库，直接使用这份 JD 文本生成简历。",
      primary: Boolean(jdId),
      payload: basePayload,
    });
  }

  const saveAction = buildSaveJDAction(data);
  if (saveAction) {
    actions.push(saveAction as ProductAction);
  }

  return actions;
}

// ── Metadata sanitizers ──────────────────────────────────────────

export function sanitizeMetadataObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const sanitized = sanitizeMetadataValue(item);
    if (sanitized !== undefined) {
      result[key] = sanitized;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeMetadataValue(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (typeof value === "object") {
    if (Array.isArray(value)) {
      const cleaned = value.map(sanitizeMetadataValue).filter((item) => item !== undefined);
      return cleaned.length > 0 ? cleaned : undefined;
    }
    return sanitizeMetadataObject(value);
  }
  return value;
}

// ── Internals ────────────────────────────────────────────────────

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
