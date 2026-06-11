import type { ProductVariant } from "../../copilot/types.js";
import type { ProductGeneratedVariant, ProductJDRecord } from "../../product/types.js";

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
  };
}
