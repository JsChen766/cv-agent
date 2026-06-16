import { z } from "zod";
import { safeParseJsonOutput } from "../infrastructure/llm/JsonOutputParser.js";
import type { ProductJDRecord, ProductResumeDetail, ProductResumeItem } from "../product/types.js";
import type { ResumeFitReport } from "./ResumeFitService.js";
import type { ResumeCompressionReport } from "./ResumeCompressionService.js";
import type { ResumeFitEditorReport } from "./ResumeLLMFitEditor.js";
import type { ResumeQualityReport } from "./ResumeQualityService.js";

/**
 * Phase 8 (LLM Critic add-on): Hybrid Resume Critic.
 *
 * The deterministic {@link ResumeQualityService} produces a stable, regex-based
 * `qualityReport` (always available). This critic runs OPTIONALLY on top of it
 * and adds a semantic, JD-aware second opinion as `qualityReport.criticReview`.
 *
 * Non-negotiable contracts (mirroring Phase 5/6/7):
 *   - Pure: no DB writes; pure functional service that depends only on the
 *     resume + reports + JD passed in.
 *   - Schema-fenced: zod-validated output. Off-schema responses fall back to
 *     `applied=false, fallback=true, reason="schema_invalid"`.
 *   - ID-provenance check: every itemId/bulletId emitted by the LLM must map
 *     to the input snapshot or it is moved to `rejectedReferences`.
 *   - Never blocks the export. Never creates a pendingAction.
 *   - hasCriticalRisks is recomputed by a MERGE rule that requires rule-layer
 *     corroboration before promoting an LLM-only "critical" risk to the
 *     report-level flag (see {@link mergeCriticReview}).
 */
export type ResumeQualityCriticReason =
  | "no_model_client"
  | "disabled_by_env"
  | "no_rule_report"
  | "schema_invalid"
  | "model_error"
  | "ok";

export type ResumeQualityCriticRiskLevel = "low" | "medium" | "high" | "critical";

export type ResumeQualityCriticRisk = {
  id: string;
  level: ResumeQualityCriticRiskLevel;
  message: string;
  itemId?: string;
  bulletId?: string;
  evidenceMissing?: boolean;
};

export type ResumeQualityCriticRewriteSuggestion = {
  id: string;
  itemId?: string;
  bulletId?: string;
  before?: string;
  suggestion: string;
  reason: string;
};

export type ResumeQualityCriticMissingEvidence = {
  id: string;
  bulletId?: string;
  claim: string;
  reason: string;
};

export type ResumeQualityCriticRejectedReference = {
  kind: "risk" | "suggestion" | "missingEvidence";
  itemId?: string;
  bulletId?: string;
  why: "unknown_item" | "unknown_bullet";
};

export type ResumeQualityCriticReview = {
  applied: boolean;
  fallback: boolean;
  reason: ResumeQualityCriticReason;
  semanticJdMatchScore?: number;
  expressionQualityScore?: number;
  authenticityRisks: ResumeQualityCriticRisk[];
  rewriteSuggestions: ResumeQualityCriticRewriteSuggestion[];
  missingEvidence: ResumeQualityCriticMissingEvidence[];
  overallComment?: string;
  rejectedReferences?: ResumeQualityCriticRejectedReference[];
  llmReason?: string;
  generatedAt: string;
};

export type ResumeQualityCriticChatFn = (input: {
  systemPrompt: string;
  userPayload: string;
}) => Promise<{ content: string }>;

export type ResumeQualityCriticServiceOptions = {
  prompt: string;
  chat?: ResumeQualityCriticChatFn;
  maxRisks?: number;
  maxSuggestions?: number;
  maxMissingEvidence?: number;
};

export type ResumeQualityCriticInput = {
  resume: ProductResumeDetail;
  items: ProductResumeItem[];
  ruleReport: ResumeQualityReport;
  fitReport: ResumeFitReport;
  compressionReport?: ResumeCompressionReport;
  editReport?: ResumeFitEditorReport;
  jd?: ProductJDRecord;
};

const DEFAULT_MAX_RISKS = 8;
const DEFAULT_MAX_SUGGESTIONS = 6;
const DEFAULT_MAX_MISSING_EVIDENCE = 6;
const MESSAGE_MAX_LEN = 240;
const REASON_MAX_LEN = 200;
const SUGGESTION_MAX_LEN = 240;
const COMMENT_MAX_LEN = 400;
const CLAIM_MAX_LEN = 200;

const RiskSchema = z.object({
  level: z.enum(["low", "medium", "high", "critical"]),
  message: z.string().min(1).max(MESSAGE_MAX_LEN * 4),
  itemId: z.string().nullable().optional(),
  bulletId: z.string().nullable().optional(),
  evidenceMissing: z.boolean().nullable().optional(),
});

const RewriteSuggestionSchema = z.object({
  itemId: z.string().nullable().optional(),
  bulletId: z.string().nullable().optional(),
  before: z.string().nullable().optional(),
  suggestion: z.string().min(1).max(SUGGESTION_MAX_LEN * 4),
  reason: z.string().min(1).max(REASON_MAX_LEN * 4),
});

const MissingEvidenceSchema = z.object({
  bulletId: z.string().nullable().optional(),
  claim: z.string().min(1).max(CLAIM_MAX_LEN * 4),
  reason: z.string().min(1).max(REASON_MAX_LEN * 4),
});

const ResponseSchema = z.object({
  semanticJdMatchScore: z.number().min(0).max(100).nullable().optional(),
  expressionQualityScore: z.number().min(0).max(100).nullable().optional(),
  authenticityReview: z
    .object({
      risks: z.array(RiskSchema).max(64).optional().default([]),
    })
    .optional()
    .default({ risks: [] }),
  rewriteSuggestions: z.array(RewriteSuggestionSchema).max(64).optional().default([]),
  missingEvidence: z.array(MissingEvidenceSchema).max(64).optional().default([]),
  overallComment: z.string().max(COMMENT_MAX_LEN * 4).optional().default(""),
});
export class ResumeQualityCriticService {
  private readonly prompt: string;
  private readonly chat: ResumeQualityCriticChatFn | undefined;
  private readonly maxRisks: number;
  private readonly maxSuggestions: number;
  private readonly maxMissingEvidence: number;

  public constructor(options: ResumeQualityCriticServiceOptions) {
    this.prompt = options.prompt;
    this.chat = options.chat;
    this.maxRisks = options.maxRisks ?? DEFAULT_MAX_RISKS;
    this.maxSuggestions = options.maxSuggestions ?? DEFAULT_MAX_SUGGESTIONS;
    this.maxMissingEvidence = options.maxMissingEvidence ?? DEFAULT_MAX_MISSING_EVIDENCE;
  }

  public async review(input: ResumeQualityCriticInput): Promise<ResumeQualityCriticReview> {
    if (!this.chat) {
      return fallbackReview("no_model_client");
    }
    if (!input.ruleReport) {
      return fallbackReview("no_rule_report");
    }

    const itemSnapshots = buildItemSnapshots(input.items, input.ruleReport);
    const knownItemIds = new Set<string>(itemSnapshots.map((it) => it.itemId));
    const knownBulletIds = new Map<string, Set<string>>();
    for (const it of itemSnapshots) {
      knownBulletIds.set(it.itemId, new Set(it.bullets.map((b) => b.bulletId)));
    }

    const userPayload = JSON.stringify({
      ruleReport: {
        overallScore: input.ruleReport.overallScore,
        authenticityScore: input.ruleReport.authenticityScore,
        jdMatchScore: input.ruleReport.jdMatchScore,
        evidenceScore: input.ruleReport.evidenceScore,
        metricScore: input.ruleReport.metricScore,
        expressionScore: input.ruleReport.expressionScore,
        layoutScore: input.ruleReport.layoutScore,
        unsupportedClaims: input.ruleReport.unsupportedClaims,
        hasCriticalRisks: input.ruleReport.hasCriticalRisks,
      },
      fit: {
        overflowPx: input.fitReport.overflowPx,
        underflowPx: input.fitReport.underflowPx ?? Math.max(0, input.fitReport.pageUsableHeightPx - input.fitReport.contentHeightPx),
        estimatedPages: input.fitReport.estimatedPages,
        density: input.fitReport.density,
      },
      compressionApplied: !!input.compressionReport?.applied,
      editApplied: !!input.editReport?.applied,
      jdSummary: input.jd?.rawText ? truncate(input.jd.rawText, 1200) : null,
      items: itemSnapshots,
    });

    let raw: string;
    try {
      const response = await this.chat({ systemPrompt: this.prompt, userPayload });
      raw = response.content ?? "";
    } catch (error) {
      return fallbackReview("model_error", { llmReason: messageOf(error) });
    }

    const parsed = safeParseJsonOutput<unknown>(raw, { expected: "object" });
    if (!parsed.ok) {
      return fallbackReview("schema_invalid", { llmReason: parsed.error.message });
    }
    const validation = ResponseSchema.safeParse(parsed.value);
    if (!validation.success) {
      return fallbackReview("schema_invalid", {
        llmReason: validation.error.issues.slice(0, 3).map((i) => i.message).join("; "),
      });
    }

    const data = validation.data;
    const rejected: ResumeQualityCriticRejectedReference[] = [];
    const authenticityRisks: ResumeQualityCriticRisk[] = [];
    const rewriteSuggestions: ResumeQualityCriticRewriteSuggestion[] = [];
    const missingEvidence: ResumeQualityCriticMissingEvidence[] = [];
    let counter = 0;

    for (const r of data.authenticityReview.risks.slice(0, this.maxRisks)) {
      const refCheck = checkReference(r.itemId, r.bulletId, knownItemIds, knownBulletIds);
      if (refCheck) {
        rejected.push({ kind: "risk", itemId: r.itemId ?? undefined, bulletId: r.bulletId ?? undefined, why: refCheck });
        continue;
      }
      authenticityRisks.push({
        id: `cr-r-${counter++}`,
        level: r.level,
        message: truncate(r.message, MESSAGE_MAX_LEN),
        ...(r.itemId ? { itemId: r.itemId } : {}),
        ...(r.bulletId ? { bulletId: r.bulletId } : {}),
        ...(r.evidenceMissing != null ? { evidenceMissing: r.evidenceMissing } : {}),
      });
    }
    for (const s of data.rewriteSuggestions.slice(0, this.maxSuggestions)) {
      const refCheck = checkReference(s.itemId, s.bulletId, knownItemIds, knownBulletIds);
      if (refCheck) {
        rejected.push({ kind: "suggestion", itemId: s.itemId ?? undefined, bulletId: s.bulletId ?? undefined, why: refCheck });
        continue;
      }
      const sanitized = sanitizeSuggestion(s.suggestion, SUGGESTION_MAX_LEN);
      if (!sanitized) continue;
      rewriteSuggestions.push({
        id: `cr-s-${counter++}`,
        ...(s.itemId ? { itemId: s.itemId } : {}),
        ...(s.bulletId ? { bulletId: s.bulletId } : {}),
        ...(s.before ? { before: truncate(s.before, SUGGESTION_MAX_LEN) } : {}),
        suggestion: sanitized,
        reason: truncate(s.reason, REASON_MAX_LEN),
      });
    }

    for (const m of data.missingEvidence.slice(0, this.maxMissingEvidence)) {
      if (m.bulletId) {
        const exists = Array.from(knownBulletIds.values()).some((set) => set.has(m.bulletId as string));
        if (!exists) {
          rejected.push({ kind: "missingEvidence", bulletId: m.bulletId, why: "unknown_bullet" });
          continue;
        }
      }
      missingEvidence.push({
        id: `cr-m-${counter++}`,
        ...(m.bulletId ? { bulletId: m.bulletId } : {}),
        claim: truncate(m.claim, CLAIM_MAX_LEN),
        reason: truncate(m.reason, REASON_MAX_LEN),
      });
    }

    return {
      applied: true,
      fallback: false,
      reason: "ok",
      ...(typeof data.semanticJdMatchScore === "number" ? { semanticJdMatchScore: roundScore(data.semanticJdMatchScore) } : {}),
      ...(typeof data.expressionQualityScore === "number" ? { expressionQualityScore: roundScore(data.expressionQualityScore) } : {}),
      authenticityRisks,
      rewriteSuggestions,
      missingEvidence,
      ...(data.overallComment ? { overallComment: truncate(data.overallComment, COMMENT_MAX_LEN) } : {}),
      ...(rejected.length > 0 ? { rejectedReferences: rejected } : {}),
      generatedAt: new Date().toISOString(),
    };
  }
}

export type ResumeQualityCriticBulletProvenance = {
  noEvidenceBulletIds: string[];
  unsupportedBulletIds: string[];
};

/**
 * Merge an LLM critic review into a deterministic rule report.
 *
 * Contract:
 *   - The rule report fields (risks, suggestions, scores, etc.) are
 *     preserved verbatim ¡ª the critic NEVER overwrites the deterministic baseline.
 *   - `criticReview` is appended (even on fallback).
 *   - `hasCriticalRisks` is recomputed:
 *       * stays true if any rule-layer risk is "critical", OR
 *       * becomes true ONLY when an LLM critic risk is "critical" AND its
 *         bullet is corroborated by the rule layer (bullet text appears in
 *         `ruleReport.unsupportedClaims` OR the input snapshot recorded
 *         `hasEvidence: false` for that bullet).
 *     This implements the "»¥ÏàÓ¡Ö¤" requirement and prevents an LLM-only
 *     verdict from triggering a critical state.
 */
export function mergeCriticReview(
  ruleReport: ResumeQualityReport,
  review: ResumeQualityCriticReview,
  bulletProvenance: ResumeQualityCriticBulletProvenance,
): ResumeQualityReport {
  const ruleHasCritical = ruleReport.risks.some((r) => r.level === "critical");
  const unsupportedTexts = new Set<string>(ruleReport.unsupportedClaims.map((s) => normalizeClaim(s)));
  const noEvidenceBullets = new Set<string>(bulletProvenance.noEvidenceBulletIds);
  const unsupportedBullets = new Set<string>(bulletProvenance.unsupportedBulletIds);

  const llmCriticalCorroborated =
    review.applied &&
    review.authenticityRisks.some((r) => {
      if (r.level !== "critical") return false;
      if (r.bulletId && (noEvidenceBullets.has(r.bulletId) || unsupportedBullets.has(r.bulletId))) return true;
      const norm = normalizeClaim(r.message);
      for (const u of unsupportedTexts) {
        if (u && (norm.includes(u) || u.includes(norm))) return true;
      }
      return false;
    });

  const hasCriticalRisks = ruleHasCritical || llmCriticalCorroborated;
  return {
    ...ruleReport,
    hasCriticalRisks,
    criticReview: review,
  };
}

// ---- helpers -----------------------------------------------------------------

type ItemSnapshot = {
  itemId: string;
  sectionType: string;
  title: string;
  header: string;
  bullets: Array<{
    bulletId: string;
    text: string;
    lengthChars: number;
    relevance: number;
    hasEvidence: boolean;
    isUnsupported: boolean;
  }>;
};

function buildItemSnapshots(
  items: ProductResumeItem[],
  ruleReport: ResumeQualityReport,
): ItemSnapshot[] {
  const unsupportedTexts = new Set<string>(
    ruleReport.unsupportedClaims.map((s) => normalizeClaim(s)),
  );
  const out: ItemSnapshot[] = [];
  for (const it of items) {
    if (it.hidden) continue;
    const meta = (it.metadata ?? {}) as Record<string, unknown>;
    const bulletIds = readStringArray(meta, "bulletIds");
    const bulletEvidence = readStringMap(meta, "bulletEvidence");
    const itemSourceExperienceId =
      (meta.sourceExperienceId as string | undefined) ??
      (it as { sourceExperienceId?: string }).sourceExperienceId;
    const relevanceMap = readNumberMap(meta, "bulletRelevance");
    const parsed = parseSnapshot(it.contentSnapshot);
    const itemId = typeof meta.itemId === "string" ? meta.itemId : it.id;
    const bullets: ItemSnapshot["bullets"] = parsed.bullets.map((text, i) => {
      const bid = bulletIds[i] ?? `_bullet_${i}`;
      const hasEvidence = Boolean(bulletEvidence[bid]) || Boolean(itemSourceExperienceId);
      const norm = normalizeClaim(text);
      const isUnsupported = unsupportedTexts.has(norm);
      const rel = typeof relevanceMap[bid] === "number" ? relevanceMap[bid] : 0.5;
      return {
        bulletId: bid,
        text,
        lengthChars: text.length,
        relevance: rel,
        hasEvidence,
        isUnsupported,
      };
    });
    out.push({
      itemId,
      sectionType: it.sectionType,
      title: it.title,
      header: parsed.header,
      bullets,
    });
  }
  return out;
}

/**
 * Compute a {@link ResumeQualityCriticBulletProvenance} snapshot from the same
 * items the rule layer evaluated. Used by {@link mergeCriticReview} to validate
 * LLM "critical" risks against rule-layer evidence.
 */
export function buildCriticBulletProvenance(
  items: ProductResumeItem[],
  ruleReport: ResumeQualityReport,
): ResumeQualityCriticBulletProvenance {
  const noEvidenceBulletIds: string[] = [];
  const unsupportedBulletIds: string[] = [];
  const snapshots = buildItemSnapshots(items, ruleReport);
  for (const it of snapshots) {
    for (const b of it.bullets) {
      if (!b.hasEvidence) noEvidenceBulletIds.push(b.bulletId);
      if (b.isUnsupported) unsupportedBulletIds.push(b.bulletId);
    }
  }
  return { noEvidenceBulletIds, unsupportedBulletIds };
}

function checkReference(
  itemId: string | null | undefined,
  bulletId: string | null | undefined,
  knownItemIds: Set<string>,
  knownBulletIds: Map<string, Set<string>>,
): "unknown_item" | "unknown_bullet" | null {
  if (!itemId && !bulletId) return null;
  if (itemId) {
    if (!knownItemIds.has(itemId)) return "unknown_item";
    if (bulletId) {
      const set = knownBulletIds.get(itemId);
      if (!set || !set.has(bulletId)) return "unknown_bullet";
    }
    return null;
  }
  if (bulletId) {
    for (const set of knownBulletIds.values()) {
      if (set.has(bulletId)) return null;
    }
    return "unknown_bullet";
  }
  return null;
}

function sanitizeSuggestion(text: string, maxLen: number): string | null {
  let cleaned = (text ?? "").replace(/\r?\n+/g, " ").replace(/\s+/g, " ").trim();
  cleaned = cleaned.replace(/^[-\u2022*]\s+/, "");
  if (cleaned.length === 0) return null;
  if (cleaned.length > maxLen) cleaned = cleaned.slice(0, maxLen).trimEnd();
  return cleaned;
}

function fallbackReview(
  reason: ResumeQualityCriticReason,
  extras: Partial<ResumeQualityCriticReview> = {},
): ResumeQualityCriticReview {
  return {
    applied: false,
    fallback: true,
    reason,
    authenticityRisks: [],
    rewriteSuggestions: [],
    missingEvidence: [],
    generatedAt: new Date().toISOString(),
    ...extras,
  };
}

function truncate(text: string, max: number): string {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd();
}

function roundScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function messageOf(error: unknown): string {
  if (!error) return "";
  if (error instanceof Error) return error.message;
  return String(error);
}

function normalizeClaim(text: string): string {
  return (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function parseSnapshot(snapshot: string): { header: string; bullets: string[] } {
  const lines = (snapshot ?? "").split(/\r?\n/);
  let header = "";
  const bullets: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const m = /^[-\u2022*]\s+(.*)$/.exec(line);
    if (m) {
      bullets.push(m[1].trim());
      continue;
    }
    if (header === "" && bullets.length === 0) {
      header = line;
    }
  }
  return { header, bullets };
}

function readStringArray(meta: Record<string, unknown> | undefined, key: string): string[] {
  if (!meta) return [];
  const v = meta[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function readStringMap(meta: Record<string, unknown> | undefined, key: string): Record<string, string> {
  if (!meta) return {};
  const v = meta[key];
  if (!v || typeof v !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

function readNumberMap(meta: Record<string, unknown> | undefined, key: string): Record<string, number> {
  if (!meta) return {};
  const v = meta[key];
  if (!v || typeof v !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "number" && Number.isFinite(val)) out[k] = val;
  }
  return out;
}