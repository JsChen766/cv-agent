import type { ProductJDRecord, ProductResumeDetail, ProductResumeItem } from "../product/types.js";
import type { ResumeFitReport } from "./ResumeFitService.js";
import type { ResumeCompressionReport } from "./ResumeCompressionService.js";
import type { ResumeFitEditorReport } from "./ResumeLLMFitEditor.js";
import type { ResumeLayoutReport } from "./layout/ResumeLayoutOracle.js";

/**
 * Phase 8: Resume quality report. Deterministic / rule-based.
 *
 * The service is invoked once at the end of the export pipeline (after Phase 5
 * measurement, Phase 6 rule compression, and Phase 7 LLM fit edits) and writes
 * a `qualityReport` onto the export record. Two non-negotiable contracts:
 *
 * 1. NEVER fail the export. Any error inside the service is swallowed by the
 *    caller and the export proceeds without `qualityReport`. This inherits
 *    the warn-only contract from Phase 5/6/7.
 * 2. NEVER produce a confirmation loop. `hasCriticalRisks=true` is metadata
 *    only — Phase 8 itself does not gate the export. Phase 10 (or a future
 *    explicit user-driven flow) may opt-in to gating.
 */
export type ResumeQualityRiskLevel = "low" | "medium" | "high" | "critical";

export type ResumeQualityDimension =
  | "authenticity"
  | "jd_match"
  | "evidence"
  | "metric"
  | "expression"
  | "layout";

export type ResumeQualityRisk = {
  id: string;
  level: ResumeQualityRiskLevel;
  dimension: ResumeQualityDimension;
  message: string;
  itemId?: string;
  bulletId?: string;
};

export type ResumeQualitySuggestion = {
  id: string;
  dimension: ResumeQualityDimension;
  message: string;
  itemId?: string;
  bulletId?: string;
};

export type ResumeQualityReport = {
  overallScore: number;
  authenticityScore: number;
  jdMatchScore: number;
  evidenceScore: number;
  metricScore: number;
  expressionScore: number;
  layoutScore: number;
  risks: ResumeQualityRisk[];
  suggestions: ResumeQualitySuggestion[];
  unsupportedClaims: string[];
  hasCriticalRisks: boolean;
  generatedAt: string;
  /**
   * Optional Hybrid Resume Critic review appended by
   * {@link import("./ResumeQualityCriticService.js").mergeCriticReview}.
   * Always advisory: never overrides the deterministic baseline; presence of
   * `criticReview.applied=true` does NOT by itself flip `hasCriticalRisks`.
   */
  criticReview?: import("./ResumeQualityCriticService.js").ResumeQualityCriticReview;
  layoutReport?: ResumeLayoutReport;
};

export type ResumeQualityInput = {
  resume: ProductResumeDetail;
  items: ProductResumeItem[];
  density: string;
  fitReport: ResumeFitReport;
  compressionReport?: ResumeCompressionReport;
  editReport?: ResumeFitEditorReport;
  jd?: ProductJDRecord;
};

const DIMENSION_WEIGHTS: Record<ResumeQualityDimension, number> = {
  authenticity: 25,
  jd_match: 25,
  evidence: 20,
  metric: 10,
  expression: 10,
  layout: 10,
};

// Hyperbolic phrases that need supporting evidence. Lowercased English + raw zh.
const HYPE_PATTERNS: RegExp[] = [
  /\b100\s*%\b/,
  /\bperfect\b/i,
  /\bindustry-?first\b/i,
  /\bworld-?(class|first)\b/i,
  /\bbest[- ]in[- ]class\b/i,
  /\bfirst[- ]ever\b/i,
  /\boutperformed\s+all\b/i,
  /业界首创/, /业内领先/, /顶级/, /顶尖/, /完美/, /最佳/, /世界第一/, /全球首/, /唯一/,
];

const ACTION_VERB_PATTERNS: RegExp[] = [
  /^(?:built|led|drove|launched|shipped|designed|architected|implemented|optimi[sz]ed|reduced|improved|created|delivered|migrated|automated|owned|founded|scaled|established|developed|coordinated|mentored|managed|onboarded|refactored|wrote|orchestrated)\b/i,
  /^(?:负责|主导|搭建|设计|实现|交付|优化|提升|降低|减少|完成|建立|协调|带领|主持|推动|落地|开发|重构|迁移|对接|从0到1)/,
];

const METRIC_PATTERN = /(\d+(?:[\.,]\d+)?\s*(?:%|x|×|倍|万|k|K|m|M|h|hours?|days?|weeks?|months?))|\d+/;

export class ResumeQualityService {
  public evaluate(input: ResumeQualityInput): ResumeQualityReport {
    const bullets = collectBullets(input.items);
    const risks: ResumeQualityRisk[] = [];
    const suggestions: ResumeQualitySuggestion[] = [];
    const unsupportedClaims: string[] = [];

    const authenticityScore = scoreAuthenticity(bullets, risks, unsupportedClaims);
    const jdMatchScore = scoreJdMatch(bullets, input.jd, risks);
    const evidenceScore = scoreEvidence(bullets, risks);
    const metricScore = scoreMetric(bullets, suggestions);
    const expressionScore = scoreExpression(bullets, suggestions);
    const layoutScore = scoreLayout(input.fitReport, input.compressionReport, input.editReport, risks, suggestions);

    const overallScore = round(
      (authenticityScore * DIMENSION_WEIGHTS.authenticity +
        jdMatchScore * DIMENSION_WEIGHTS.jd_match +
        evidenceScore * DIMENSION_WEIGHTS.evidence +
        metricScore * DIMENSION_WEIGHTS.metric +
        expressionScore * DIMENSION_WEIGHTS.expression +
        layoutScore * DIMENSION_WEIGHTS.layout) /
        Object.values(DIMENSION_WEIGHTS).reduce((a, b) => a + b, 0),
    );
    const hasCriticalRisks = risks.some((r) => r.level === "critical");
    return {
      overallScore,
      authenticityScore: round(authenticityScore),
      jdMatchScore: round(jdMatchScore),
      evidenceScore: round(evidenceScore),
      metricScore: round(metricScore),
      expressionScore: round(expressionScore),
      layoutScore: round(layoutScore),
      risks,
      suggestions,
      unsupportedClaims,
      hasCriticalRisks,
      generatedAt: new Date().toISOString(),
    };
  }
}

type CollectedBullet = {
  itemId: string;
  bulletId: string;
  text: string;
  evidenceStrength: number;
  hasEvidence: boolean;
  itemRelevance: number;
  pinned: boolean;
};

function collectBullets(items: ProductResumeItem[]): CollectedBullet[] {
  const out: CollectedBullet[] = [];
  for (const item of items) {
    if ((item as { hidden?: boolean }).hidden === true) continue;
    const meta = ((item as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<string, unknown>;
    const itemId = (meta.itemId as string | undefined) ?? item.id;
    const bulletIds = Array.isArray(meta.bulletIds) ? (meta.bulletIds as string[]) : [];
    const bulletTexts = readStringMap(meta.bulletTexts);
    const bulletEvidence = readStringMap(meta.bulletEvidence);
    const itemSourceExperienceId = (meta.sourceExperienceId as string | undefined) ?? (item as { sourceExperienceId?: string }).sourceExperienceId;
    const itemRelevance = typeof meta.relevanceScore === "number" ? (meta.relevanceScore as number) : 0.5;
    const pinned = (item as { pinned?: boolean }).pinned === true;

    if (bulletIds.length > 0) {
      for (const bid of bulletIds) {
        const text = bulletTexts[bid] ?? extractBulletFromSnapshot(item.contentSnapshot, bid);
        if (!text) continue;
        const hasEvidence = Boolean(bulletEvidence[bid]) || Boolean(itemSourceExperienceId);
        out.push({
          itemId, bulletId: bid, text, hasEvidence,
          evidenceStrength: hasEvidence ? 1 : 0,
          itemRelevance, pinned,
        });
      }
    } else {
      const lines = (item.contentSnapshot ?? "").split(/\r?\n/).map((l) => l.replace(/^[-*•]\s*/, "").trim()).filter(Boolean);
      for (let i = 0; i < lines.length; i += 1) {
        out.push({
          itemId, bulletId: `${itemId}-bullet-${i}`, text: lines[i]!,
          hasEvidence: Boolean(itemSourceExperienceId),
          evidenceStrength: itemSourceExperienceId ? 1 : 0,
          itemRelevance, pinned,
        });
      }
    }
  }
  return out;
}

function readStringMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && v) out[k] = v;
  }
  return out;
}

function extractBulletFromSnapshot(_snapshot: string | undefined, _bulletId: string): string | null {
  return null;
}

function round(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.max(0, Math.min(100, value)));
}

function scoreAuthenticity(bullets: CollectedBullet[], risks: ResumeQualityRisk[], unsupportedClaims: string[]): number {
  if (bullets.length === 0) return 80;
  let unsupportedHigh = 0;
  let unsupportedAny = 0;
  for (const b of bullets) {
    const isHype = HYPE_PATTERNS.some((p) => p.test(b.text));
    if (!isHype) continue;
    if (b.hasEvidence) continue;
    unsupportedClaims.push(b.text);
    unsupportedAny += 1;
    if (b.itemRelevance >= 0.6) {
      unsupportedHigh += 1;
      risks.push({
        id: `authenticity:unsupported_high_impact:${b.bulletId}`,
        level: "critical",
        dimension: "authenticity",
        message: `High-impact bullet contains an unsupported superlative claim ("${truncate(b.text, 80)}"). Add a sourceExperienceId or rephrase.`,
        itemId: b.itemId,
        bulletId: b.bulletId,
      });
    } else {
      risks.push({
        id: `authenticity:unsupported:${b.bulletId}`,
        level: "medium",
        dimension: "authenticity",
        message: `Bullet uses a superlative without supporting evidence ("${truncate(b.text, 80)}").`,
        itemId: b.itemId,
        bulletId: b.bulletId,
      });
    }
  }
  if (unsupportedAny === 0) return 95;
  const ratio = unsupportedAny / bullets.length;
  let score = 100 - ratio * 80 - unsupportedHigh * 20;
  if (score < 0) score = 0;
  return score;
}

function scoreJdMatch(bullets: CollectedBullet[], jd: ProductJDRecord | undefined, risks: ResumeQualityRisk[]): number {
  if (!jd) return 60;
  if (bullets.length === 0) return 50;
  const keywords = extractJdKeywords(jd.rawText);
  if (keywords.length === 0) return 60;
  const bulletText = bullets.map((b) => b.text.toLowerCase()).join(" \n ");
  let hits = 0;
  for (const kw of keywords) if (bulletText.includes(kw)) hits += 1;
  const coverage = hits / keywords.length;
  const score = Math.round(coverage * 100);
  if (coverage < 0.3) {
    risks.push({
      id: "jd_match:low_coverage",
      level: "high",
      dimension: "jd_match",
      message: `Only ${hits}/${keywords.length} JD keywords appear in the resume. Consider rewriting bullets around required skills.`,
    });
  } else if (coverage < 0.5) {
    risks.push({
      id: "jd_match:medium_coverage",
      level: "medium",
      dimension: "jd_match",
      message: `JD coverage is moderate (${hits}/${keywords.length} keywords). Strengthen alignment on missing skills.`,
    });
  }
  return score;
}

function extractJdKeywords(rawText: string): string[] {
  const lower = rawText.toLowerCase();
  // Tokens that look like skills / tech: alphanumerics with optional + - / .
  const tokens = lower.match(/[a-z][a-z0-9+#./-]{1,32}/g) ?? [];
  const stop = new Set([
    "and", "or", "the", "with", "for", "you", "we", "us", "our", "your", "in", "on", "at", "to", "of",
    "a", "an", "is", "are", "be", "as", "by", "have", "has", "must", "should", "will", "can", "able",
    "experience", "skill", "skills", "looking", "needed", "required", "preferred", "team", "role",
    "engineer", "senior", "junior", "etc", "such",
  ]);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const t of tokens) {
    const trimmed = t.replace(/[.,/]+$/, "");
    if (trimmed.length < 2) continue;
    if (stop.has(trimmed)) continue;
    if (/^\d+$/.test(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result.slice(0, 24);
}

function scoreEvidence(bullets: CollectedBullet[], risks: ResumeQualityRisk[]): number {
  if (bullets.length === 0) return 70;
  const supported = bullets.filter((b) => b.hasEvidence).length;
  const ratio = supported / bullets.length;
  if (ratio < 0.25) {
    risks.push({
      id: "evidence:very_low",
      level: "high",
      dimension: "evidence",
      message: `Only ${supported}/${bullets.length} bullets have an underlying experience reference. Bind bullets to source experiences before sharing.`,
    });
  } else if (ratio < 0.5) {
    risks.push({
      id: "evidence:low",
      level: "medium",
      dimension: "evidence",
      message: `${bullets.length - supported}/${bullets.length} bullets lack a sourceExperienceId. Consider attaching evidence.`,
    });
  }
  return Math.round(ratio * 100);
}

function scoreMetric(bullets: CollectedBullet[], suggestions: ResumeQualitySuggestion[]): number {
  if (bullets.length === 0) return 70;
  const withMetric = bullets.filter((b) => METRIC_PATTERN.test(b.text)).length;
  const ratio = withMetric / bullets.length;
  if (ratio < 0.3) {
    suggestions.push({
      id: "metric:more_numbers",
      dimension: "metric",
      message: `Only ${withMetric}/${bullets.length} bullets contain a quantitative result. Adding numbers (%, scale, time) makes the impact concrete.`,
    });
  }
  return Math.round(40 + ratio * 60);
}

function scoreExpression(bullets: CollectedBullet[], suggestions: ResumeQualitySuggestion[]): number {
  if (bullets.length === 0) return 70;
  let issues = 0;
  for (const b of bullets) {
    const len = b.text.length;
    if (len < 20) {
      issues += 1;
      suggestions.push({
        id: `expression:too_short:${b.bulletId}`,
        dimension: "expression",
        message: `Bullet is very short ("${b.text}"). Aim for action + method + result.`,
        itemId: b.itemId,
        bulletId: b.bulletId,
      });
      continue;
    }
    if (len > 220) {
      issues += 1;
      suggestions.push({
        id: `expression:too_long:${b.bulletId}`,
        dimension: "expression",
        message: `Bullet exceeds 220 characters. Consider splitting or shortening.`,
        itemId: b.itemId,
        bulletId: b.bulletId,
      });
      continue;
    }
    const startsWithVerb = ACTION_VERB_PATTERNS.some((p) => p.test(b.text));
    if (!startsWithVerb) {
      issues += 1;
      suggestions.push({
        id: `expression:weak_verb:${b.bulletId}`,
        dimension: "expression",
        message: `Bullet does not start with a clear action verb.`,
        itemId: b.itemId,
        bulletId: b.bulletId,
      });
    }
  }
  const ratio = (bullets.length - issues) / bullets.length;
  return Math.round(40 + ratio * 60);
}

function scoreLayout(
  fit: ResumeFitReport,
  compression: ResumeCompressionReport | undefined,
  edit: ResumeFitEditorReport | undefined,
  risks: ResumeQualityRisk[],
  suggestions: ResumeQualitySuggestion[],
): number {
  const overflow = Math.max(0, fit.overflowPx);
  const underflow = Math.max(0, fit.underflowPx ?? Math.max(0, fit.pageUsableHeightPx - fit.contentHeightPx));
  if (overflow > 0) {
    const stillOverflowing = compression?.stillOverflowing === true;
    const editFailed = edit ? edit.fallback === true : false;
    const exhausted = stillOverflowing && editFailed;
    risks.push({
      id: "layout:overflow",
      level: exhausted ? "high" : "medium",
      dimension: "layout",
      message: `Resume still overflows one page by ${overflow}px after Phase 6/7. Hide low-value items or pin essentials.`,
    });
    const ratio = Math.max(0, 1 - overflow / Math.max(1, fit.pageUsableHeightPx));
    const base = exhausted ? 10 : 25;
    const range = exhausted ? 35 : 45;
    return Math.round(base + ratio * range);
  }
  if (underflow >= 240 && (!edit || edit.applied !== true)) {
    suggestions.push({
      id: "layout:underflow",
      dimension: "layout",
      message: `Page usage is low (${underflow}px of empty space). Consider expanding key bullets or adding evidence.`,
    });
    return 75;
  }
  return 90;
}

function truncate(text: string, n: number): string {
  if (text.length <= n) return text;
  return `${text.slice(0, n - 1)}…`;
}
