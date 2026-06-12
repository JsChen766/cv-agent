import type { ProductVariant } from "../../copilot/types.js";
import type { ProductGeneratedVariant, ProductJDRecord, VariantComparisonMatrixRow } from "../../product/types.js";

function buildVariantActions(variantId: string, generationId: string, _index: number) {
  return [
    {
      id: `act-accept-${variantId}`,
      type: "accept" as const,
      label: "采用此版本",
      description: "将当前版本保存到简历库。",
      variantId,
      payload: { variantId, generationId },
      primary: true,
    },
    {
      id: `act-evidence-${variantId}`,
      type: "show_evidence" as const,
      label: "查看依据",
      description: "查看此版本的经历引用和证据来源。",
      variantId,
      payload: { variantId, generationId },
      primary: false,
    },
    {
      id: `act-prefer-${variantId}`,
      type: "prefer" as const,
      label: "偏好此风格",
      description: "告诉 AI 你更偏好这种表达风格，后续版本会向此靠拢。",
      variantId,
      payload: { variantId, generationId },
      primary: false,
    },
  ];
}

// ────────────────────────────────────────────────────────────────────
// Display-metadata fallbacks. Used only when the LLM omitted one of the
// product fields. Templates draw from the variant's own scores / risks
// so the user-visible copy still reflects the actual generation, not a
// random label.
// ────────────────────────────────────────────────────────────────────

const DEFAULT_VARIANT_NAMES = ["稳健通用版", "技术栈强化版", "项目成果版", "数据驱动版", "管理潜力版"] as const;

function fallbackVariantName(_variant: ProductGeneratedVariant, index: number): string {
  return DEFAULT_VARIANT_NAMES[index] ?? `版本 ${index + 1}`;
}

function fallbackSummary(variant: ProductGeneratedVariant): string {
  if (variant.reason && variant.reason.length <= 30) return variant.reason;
  if (variant.reason) return `${variant.reason.slice(0, 28).trimEnd()}…`;
  return "基于 JD 与经历库素材生成的简历版本。";
}

function fallbackScenario(variant: ProductGeneratedVariant, jd: ProductJDRecord): string {
  const role = (jd.targetRole ?? jd.title ?? "").trim();
  const scores = variant.scores ?? {};
  const tech = (scores.relevance ?? 0) >= 0.8;
  const impact = (scores.quantifiedImpact ?? 0) >= 0.8;
  if (impact) return role ? `${role} · 业绩导向` : "业绩导向岗位";
  if (tech) return role ? `${role} · 技术能力` : "技术能力导向岗位";
  return role ? `${role} · 通用投递` : "通用投递场景";
}

function fallbackAdvantages(variant: ProductGeneratedVariant): string[] {
  const out: string[] = [];
  const scores = variant.scores ?? {};
  if ((scores.relevance ?? 0) >= 0.8) out.push("JD 关键词覆盖率高");
  if ((scores.evidenceStrength ?? 0) >= 0.8) out.push("经历佐证充分");
  if ((scores.quantifiedImpact ?? 0) >= 0.8) out.push("数据指标突出");
  if ((scores.clarity ?? 0) >= 0.85) out.push("表达清晰流畅");
  if ((variant.sourceExperienceIds?.length ?? 0) >= 2) out.push("引用多段经历");
  return out.slice(0, 3);
}

function fallbackRisks(variant: ProductGeneratedVariant): string[] {
  const out: string[] = [];
  const risk = variant.riskSummary;
  if (risk?.warnings?.length) out.push(...risk.warnings.slice(0, 1));
  if (risk?.unsupportedClaims?.length) out.push("部分表达需经历佐证");
  if (variant.missingInfo?.length) out.push("有待补充信息");
  // Trim to user-friendly length and keep at most 3.
  return Array.from(new Set(out.map((s) => (s.length > 18 ? `${s.slice(0, 17)}…` : s)))).slice(0, 3);
}

function scoreLabel(value: number | undefined): string {
  if (value === undefined) return "—";
  const v = value <= 1 ? value : value / 100;
  if (v >= 0.8) return "高";
  if (v >= 0.6) return "中";
  return "低";
}

/**
 * Build a 5-dimension comparison matrix from the variants themselves
 * when the LLM did not produce one. This stays on the backend (it is
 * the source of business truth, not a frontend guess) but is purely
 * deterministic, derived from existing scores / risks.
 */
export function buildFallbackComparisonMatrix(
  variants: Array<ProductVariant & { scores?: Record<string, number> }>,
): VariantComparisonMatrixRow[] {
  if (variants.length === 0) return [];
  const cell = (text: string | undefined): string => (text && text.trim() ? text.trim() : "—");
  return [
    {
      dimension: "定位",
      values: Object.fromEntries(variants.map((v) => [v.id, cell(v.scenario)])),
    },
    {
      dimension: "JD 匹配度",
      values: Object.fromEntries(variants.map((v) => [v.id, scoreLabel(v.scores?.relevance ?? v.score?.relevance)])),
    },
    {
      dimension: "经历支撑",
      values: Object.fromEntries(variants.map((v) => [v.id, scoreLabel(v.scores?.evidenceStrength ?? v.score?.evidenceStrength)])),
    },
    {
      dimension: "数据驱动",
      values: Object.fromEntries(variants.map((v) => [v.id, scoreLabel(v.scores?.quantifiedImpact ?? v.score?.quantifiedImpact)])),
    },
    {
      dimension: "风险",
      values: Object.fromEntries(variants.map((v) => [v.id, cell(v.risks?.[0])])),
    },
  ];
}

export function toWorkspaceVariant(
  variant: ProductGeneratedVariant,
  jd: ProductJDRecord,
  generationId: string,
  index: number,
): ProductVariant & { scores?: Record<string, number> } {
  const score = variant.scores ?? {};
  const sourceExperienceIds = variant.sourceExperienceIds ?? [];
  const sourceEvidenceIds = variant.sourceEvidenceIds ?? [];
  const hasExperiences = sourceExperienceIds.length > 0;

  return {
    id: variant.id,
    artifactId: null,
    title: jd.targetRole ? `${jd.targetRole} 简历版本 ${index + 1}` : `JD 简历版本 ${index + 1}`,
    content: variant.content,
    role: index === 0 ? "recommended" : "alternative",
    status: "ready",
    score: {
      overall: score.overall,
      relevance: score.relevance,
      clarity: score.clarity,
      evidenceStrength: score.evidenceStrength,
      quantifiedImpact: score.quantifiedImpact,
    },
    badges: (() => {
      const result: Array<{ label: string; tone: "positive" | "neutral" | "warning" }> = [];
      result.push(index === 0
        ? { label: "最推荐", tone: "positive" }
        : { label: "备选方案", tone: "neutral" });
      if ((score.quantifiedImpact ?? 0) >= 80) result.push({ label: "数据驱动", tone: "positive" });
      if ((score.clarity ?? 0) >= 85) result.push({ label: "更清晰", tone: "positive" });
      result.push({
        label: hasExperiences ? "已引用经历" : "待补充经历",
        tone: hasExperiences ? "neutral" : "warning",
      });
      result.push({ label: "JD 生成", tone: "neutral" });
      return result;
    })(),
    reason: variant.reason ?? (hasExperiences
      ? "已结合 JD 与经历库素材生成，可继续核对事实和指标。"
      : "当前主要基于 JD 生成，建议补充经历库后再做精修。"),
    evidenceSummary: variant.evidenceSummary ?? {
      coverageLabel: hasExperiences
        ? `已引用 ${sourceExperienceIds.length} 条经历素材。`
        : "尚未引用经历素材。",
      items: sourceExperienceIds.map((id) => ({
        id,
        title: "经历素材",
        explanation: "该经历被用于生成当前简历草稿。",
        confidence: 0.6,
      })),
    },
    riskSummary: {
      level: variant.riskSummary?.level ?? (hasExperiences ? "medium" : "high"),
      unsupportedClaims: variant.riskSummary?.unsupportedClaims ?? [],
      missingEvidence: variant.riskSummary?.missingEvidence ?? (hasExperiences ? [] : ["缺少经历库素材支撑。"]),
      warnings: variant.riskSummary?.warnings ?? ["保存前请确认草稿中的事实、指标和项目边界。"],
    },
    missingInfo: variant.missingInfo ?? (hasExperiences ? ["请确认草稿中的指标是否真实可验证。"] : ["请补充工作或项目经历素材。"]),
    sourceExperienceIds,
    sourceEvidenceIds,
    actions: buildVariantActions(variant.id, generationId, index),
    raw: {
      generationId,
      jdId: jd.id,
      scores: score,
    },
    createdAt: variant.createdAt,
    after: variant.content,
    scores: score,
    // ── Product-level display fields ──────────────────────────────
    // Prefer LLM output verbatim; only fall back to deterministic
    // templates when a field is absent. The fallbacks read from this
    // variant's own scores and risk summary so the copy still
    // reflects what the model produced — not a hard-coded label.
    variantName: variant.variantName ?? fallbackVariantName(variant, index),
    summary: variant.summary ?? fallbackSummary(variant),
    scenario: variant.scenario ?? fallbackScenario(variant, jd),
    advantages: variant.advantages ?? fallbackAdvantages(variant),
    risks: variant.risks ?? fallbackRisks(variant),
    recommended: variant.recommended ?? (index === 0),
    rank: variant.rank ?? (index + 1),
  };
}
