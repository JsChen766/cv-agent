import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ModelClient } from "../agent-core/model/ModelClient.js";
import { PromptRegistry } from "../agent-core/prompts/PromptRegistry.js";
import { extractJsonCandidates } from "../infrastructure/llm/JsonOutputParser.js";
import type { ProductExperienceSummary, ProductGeneratedVariant, VariantComparisonMatrixRow } from "./types.js";

export type LLMGenerationErrorPhase =
  | "initial"
  | "repair"
  | "schema_validation"
  | "json_parse"
  | "provider_call";

export class LLMGenerationError extends Error {
  public readonly phase: LLMGenerationErrorPhase;
  public readonly providerErrorMessage?: string;
  public readonly rawContentPreview?: string;
  public readonly schemaIssues?: string[];

  public constructor(message: string, options: {
    phase: LLMGenerationErrorPhase;
    providerErrorMessage?: string;
    rawContentPreview?: string;
    schemaIssues?: string[];
    cause?: unknown;
  }) {
    super(message);
    this.name = "LLMGenerationError";
    this.phase = options.phase;
    this.providerErrorMessage = options.providerErrorMessage;
    this.rawContentPreview = options.rawContentPreview;
    this.schemaIssues = options.schemaIssues;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

// ═══════════════════════════════════════════════════════════════
// Normalization helpers — lenient, never throw on minor schema issues
// ═══════════════════════════════════════════════════════════════

function normalizeScore(raw: unknown): number {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed > 1 && parsed <= 100 ? parsed / 100 : clampScore(parsed);
    }
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 1 && raw <= 100 ? raw / 100 : clampScore(raw);
  }
  return 0.7; // default
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

function normalizeScoreObject(raw: unknown): {
  overall: number;
  relevance: number;
  evidenceStrength: number;
  quantifiedImpact?: number;
  clarity?: number;
} {
  if (!isRecord(raw)) return { overall: 0.7, relevance: 0.7, evidenceStrength: 0.5 };
  return {
    overall: normalizeScore(raw.overall ?? 0.7),
    relevance: normalizeScore(raw.relevance ?? 0.7),
    evidenceStrength: normalizeScore(raw.evidenceStrength ?? 0.5),
    ...(raw.quantifiedImpact !== undefined ? { quantifiedImpact: normalizeScore(raw.quantifiedImpact) } : {}),
    ...(raw.clarity !== undefined ? { clarity: normalizeScore(raw.clarity) } : {}),
  };
}

function normalizeEvidenceItem(raw: unknown, index: number): {
  id: string;
  title: string;
  explanation: string;
  confidence: number;
} {
  if (typeof raw === "string") {
    return {
      id: `evidence-${index + 1}`,
      title: raw.slice(0, 80),
      explanation: raw,
      confidence: 0.6,
    };
  }
  if (isRecord(raw)) {
    const id = typeof raw.id === "string" ? raw.id : `evidence-${index + 1}`;
    const title = typeof raw.title === "string" ? raw.title : (typeof raw.explanation === "string" ? raw.explanation.slice(0, 40) : `Evidence ${index + 1}`);
    const explanation = typeof raw.explanation === "string" ? raw.explanation : (typeof raw.title === "string" ? raw.title : JSON.stringify(raw).slice(0, 200));
    const confidence = typeof raw.confidence === "number" ? clampScore(raw.confidence)
      : typeof raw.confidence === "string" ? clampScore(Number(raw.confidence) || 0.5)
      : 0.5;
    return { id, title, explanation, confidence };
  }
  return {
    id: `evidence-${index + 1}`,
    title: `Evidence ${index + 1}`,
    explanation: String(raw).slice(0, 200),
    confidence: 0.5,
  };
}

function normalizeEvidenceSummary(raw: unknown): {
  coverageLabel: string;
  items: Array<{ id: string; title: string; explanation: string; confidence: number }>;
} | undefined {
  if (!isRecord(raw)) return undefined;
  const coverageLabel = typeof raw.coverageLabel === "string" ? raw.coverageLabel : "No evidence summary provided.";
  const itemsRaw = Array.isArray(raw.items) ? raw.items : [];
  if (itemsRaw.length === 0) return undefined;
  return {
    coverageLabel,
    items: itemsRaw.map(normalizeEvidenceItem),
  };
}

function normalizeRiskSummary(raw: unknown): {
  level: "low" | "medium" | "high" | "critical";
  unsupportedClaims?: string[];
  missingEvidence?: string[];
  warnings?: string[];
} | undefined {
  if (!isRecord(raw)) return undefined;
  const level = raw.level === "low" || raw.level === "medium" || raw.level === "high" || raw.level === "critical"
    ? raw.level
    : "medium";
  const result: ReturnType<typeof normalizeRiskSummary> = { level };
  if (Array.isArray(raw.unsupportedClaims)) result.unsupportedClaims = raw.unsupportedClaims.filter((v): v is string => typeof v === "string");
  if (Array.isArray(raw.missingEvidence)) result.missingEvidence = raw.missingEvidence.filter((v): v is string => typeof v === "string");
  if (Array.isArray(raw.warnings)) result.warnings = raw.warnings.filter((v): v is string => typeof v === "string");
  return result;
}

function normalizeMissingInfo(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items = raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  return items.length > 0 ? items : undefined;
}

function normalizeStringArray(raw: unknown, max: number, perItemMax: number): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items = raw
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, max)
    .map((v) => (v.length > perItemMax ? `${v.slice(0, perItemMax - 1).trimEnd()}…` : v));
  return items.length > 0 ? items : undefined;
}

function normalizeShortString(raw: unknown, max: number): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

function normalizeBool(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const lower = raw.trim().toLowerCase();
    if (lower === "true" || lower === "yes" || lower === "1") return true;
    if (lower === "false" || lower === "no" || lower === "0") return false;
  }
  return undefined;
}

function normalizeRank(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  if (typeof raw === "string") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return undefined;
}

function normalizeComparisonMatrix(raw: unknown): VariantComparisonMatrixRow[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const rows: VariantComparisonMatrixRow[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const dimension = typeof entry.dimension === "string" ? entry.dimension.trim() : "";
    if (!dimension) continue;
    const valuesRaw = entry.values;
    if (!isRecord(valuesRaw)) continue;
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(valuesRaw)) {
      if (typeof value === "string") values[key] = value.trim();
      else if (typeof value === "number") values[key] = String(value);
    }
    if (Object.keys(values).length === 0) continue;
    rows.push({ dimension: dimension.length > 12 ? `${dimension.slice(0, 11)}…` : dimension, values });
  }
  return rows.length > 0 ? rows.slice(0, 8) : undefined;
}

function normalizeSourceExperienceIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

/**
 * Normalize a single variant from raw LLM output.
 * Never throws — returns null only if content is completely missing.
 */
function normalizeVariant(raw: unknown, index: number): NormalizedVariant | null {
  if (!isRecord(raw)) return null;
  const content = typeof raw.content === "string" && raw.content.trim().length > 0
    ? raw.content.trim()
    : "";
  if (!content) return null; // content is the only hard requirement

  const scores = normalizeScoreObject(raw.score ?? raw.scores);

  return {
    content,
    scores,
    reason: typeof raw.reason === "string" && raw.reason.trim()
      ? raw.reason.trim()
      : "Generated based on JD and experience library.",
    sourceExperienceIds: normalizeSourceExperienceIds(raw.sourceExperienceIds),
    evidenceSummary: normalizeEvidenceSummary(raw.evidenceSummary),
    riskSummary: normalizeRiskSummary(raw.riskSummary),
    missingInfo: normalizeMissingInfo(raw.missingInfo),
    variantName: normalizeShortString(raw.variantName ?? raw.name, 12),
    summary: normalizeShortString(raw.summary ?? raw.summaryLine, 32),
    scenario: normalizeShortString(raw.scenario ?? raw.position, 14),
    advantages: normalizeStringArray(raw.advantages ?? raw.strengths ?? raw.pros, 4, 14),
    risks: normalizeStringArray(raw.risks ?? raw.cautions ?? raw.cons, 3, 18),
    recommended: normalizeBool(raw.recommended ?? raw.preferred ?? raw.isRecommended),
    rank: normalizeRank(raw.rank),
  };
}

function normalizeGenerationResult(raw: unknown): {
  variants: NormalizedVariant[];
  recommendedVariantKey?: string;
  comparisonMatrix?: VariantComparisonMatrixRow[];
} {
  if (Array.isArray(raw)) {
    return { variants: normalizeVariantList(raw) };
  }
  if (isRecord(raw)) {
    const variants = Array.isArray(raw.variants)
      ? normalizeVariantList(raw.variants)
      : [];
    const recommendedVariantKey = typeof raw.recommendedVariantId === "string"
      ? raw.recommendedVariantId.trim() || undefined
      : undefined;
    const comparisonMatrix = normalizeComparisonMatrix(raw.comparisonMatrix);
    return { variants, recommendedVariantKey, comparisonMatrix };
  }
  return { variants: [] };
}

function normalizeVariantList(raw: unknown[]): NormalizedVariant[] {
  const variants: NormalizedVariant[] = [];
  for (let i = 0; i < raw.length && variants.length < 5; i++) {
    const v = normalizeVariant(raw[i], i);
    if (v) variants.push(v);
  }
  return variants;
}

// ═══════════════════════════════════════════════════════════════
// Internal normalized type (after preprocessing, before zod)
// ═══════════════════════════════════════════════════════════════

type NormalizedVariant = {
  content: string;
  scores: {
    overall: number;
    relevance: number;
    evidenceStrength: number;
    quantifiedImpact?: number;
    clarity?: number;
  };
  reason: string;
  sourceExperienceIds: string[];
  evidenceSummary?: {
    coverageLabel: string;
    items: Array<{ id: string; title: string; explanation: string; confidence: number }>;
  };
  riskSummary?: {
    level: "low" | "medium" | "high" | "critical";
    unsupportedClaims?: string[];
    missingEvidence?: string[];
    warnings?: string[];
  };
  missingInfo?: string[];
  variantName?: string;
  summary?: string;
  scenario?: string;
  advantages?: string[];
  risks?: string[];
  recommended?: boolean;
  rank?: number;
};

// ═══════════════════════════════════════════════════════════════
// Strict zod schema — only used AFTER normalization, so it should always pass
// ═══════════════════════════════════════════════════════════════

const NormalizedEvidenceItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  explanation: z.string(),
  confidence: z.number().min(0).max(1),
});

const NormalizedVariantSchema = z.object({
  content: z.string().min(1),
  scores: z.object({
    overall: z.number().min(0).max(1),
    relevance: z.number().min(0).max(1),
    evidenceStrength: z.number().min(0).max(1),
    quantifiedImpact: z.number().min(0).max(1).optional(),
    clarity: z.number().min(0).max(1).optional(),
  }),
  reason: z.string(),
  sourceExperienceIds: z.array(z.string()),
  evidenceSummary: z.object({
    coverageLabel: z.string(),
    items: z.array(NormalizedEvidenceItemSchema),
  }).optional(),
  riskSummary: z.object({
    level: z.enum(["low", "medium", "high", "critical"]),
    unsupportedClaims: z.array(z.string()).optional(),
    missingEvidence: z.array(z.string()).optional(),
    warnings: z.array(z.string()).optional(),
  }).optional(),
  missingInfo: z.array(z.string()).optional(),
  variantName: z.string().optional(),
  summary: z.string().optional(),
  scenario: z.string().optional(),
  advantages: z.array(z.string()).optional(),
  risks: z.array(z.string()).optional(),
  recommended: z.boolean().optional(),
  rank: z.number().int().positive().optional(),
});

const ComparisonMatrixRowSchema = z.object({
  dimension: z.string(),
  values: z.record(z.string(), z.string()),
});

const NormalizedGenerationResultSchema = z.object({
  variants: z.array(NormalizedVariantSchema).min(1).max(5),
  recommendedVariantKey: z.string().optional(),
  comparisonMatrix: z.array(ComparisonMatrixRowSchema).optional(),
});

// ═══════════════════════════════════════════════════════════════
// Prompts
// ═══════════════════════════════════════════════════════════════

const PROMPTS = new PromptRegistry();
const SYSTEM_PROMPT = PROMPTS.get("product.generation.resumeSystem");

function buildUserPrompt(
  jdText: string,
  targetRole: string | undefined,
  experiences: ProductExperienceSummary[],
): string {
  const expSection = experiences.length > 0
    ? experiences.map((exp, i) => {
        const parts = [
          `[${exp.id}] ${exp.title}`,
          exp.organization ? `@ ${exp.organization}` : "",
          exp.role ? `as ${exp.role}` : "",
          exp.startDate || exp.endDate ? `(${exp.startDate ?? "?"} - ${exp.endDate ?? "?"})` : "",
          "",
          exp.content ? exp.content.slice(0, 600) : "",
        ];
        return parts.filter(Boolean).join(" ");
      }).join("\n\n")
    : "NO EXPERIENCES AVAILABLE. The candidate has not added any experiences yet.";

  return [
    targetRole ? `Target role: ${targetRole}` : "",
    "",
    "Job Description:",
    jdText.slice(0, 4000),
    "",
    "Candidate Experience Library:",
    expSection,
    "",
    "Generate resume content variants. Return a JSON object with a 'variants' array.",
  ].join("\n");
}

const REPAIR_PROMPT = PROMPTS.get("product.generation.resumeRepair");

// ═══════════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════════

export class LLMGenerationService {
  public constructor(private readonly modelClient: ModelClient) {}

  public async generateVariants(
    userId: string,
    jdText: string,
    targetRole: string | undefined,
    experiences: ProductExperienceSummary[],
  ): Promise<{
    variants: ProductGeneratedVariant[];
    recommendedVariantId?: string;
    comparisonMatrix?: VariantComparisonMatrixRow[];
  }> {
    const result = await this.tryGenerate(jdText, targetRole, experiences);
    const now = new Date().toISOString();
    // The LLM may reference variants by either positional key ("v0",
    // "v1", ...) or by an opaque id it invented. We assign the real
    // variant id at this layer and rewrite both `recommendedVariantId`
    // and the per-row matrix `values` keys in one pass so downstream
    // (the tool, the workspace, the frontend) only sees real ids.
    const variants: ProductGeneratedVariant[] = result.variants.map((variant, index) => ({
      id: `pvar-${randomUUID()}`,
      userId,
      content: variant.content,
      reason: variant.reason,
      sourceExperienceIds: variant.sourceExperienceIds ?? [],
      sourceEvidenceIds: [],
      scores: {
        overall: variant.scores.overall,
        relevance: variant.scores.relevance,
        evidenceStrength: variant.scores.evidenceStrength,
        ...(variant.scores.quantifiedImpact != null ? { quantifiedImpact: variant.scores.quantifiedImpact } : {}),
        ...(variant.scores.clarity != null ? { clarity: variant.scores.clarity } : {}),
      },
      evidenceSummary: variant.evidenceSummary,
      riskSummary: variant.riskSummary,
      missingInfo: variant.missingInfo,
      variantName: variant.variantName,
      summary: variant.summary,
      scenario: variant.scenario,
      advantages: variant.advantages,
      risks: variant.risks,
      recommended: variant.recommended,
      rank: variant.rank,
      createdAt: now,
    }));

    // Build a positional → real id map ("v0" → variants[0].id, ...).
    const idByKey = new Map<string, string>();
    variants.forEach((v, i) => {
      idByKey.set(`v${i}`, v.id);
      idByKey.set(String(i), v.id);
      idByKey.set(v.id, v.id);
    });

    const recommendedFromLlm = result.recommendedVariantKey
      ? idByKey.get(result.recommendedVariantKey)
      : undefined;
    const recommendedFromFlag = variants.find((v) => v.recommended)?.id;
    const recommendedByScore = (() => {
      if (variants.length === 0) return undefined;
      let best = variants[0];
      for (const v of variants) {
        if ((v.scores?.overall ?? 0) > (best.scores?.overall ?? 0)) best = v;
      }
      return best.id;
    })();
    const recommendedVariantId = recommendedFromLlm ?? recommendedFromFlag ?? recommendedByScore;

    // Mark the chosen variant as recommended; clear the flag on the
    // others so exactly one survives. Matches the prompt contract.
    if (recommendedVariantId) {
      for (const v of variants) v.recommended = v.id === recommendedVariantId;
    }
    // Backfill rank if absent (1 = top).
    const ranked = [...variants].sort((a, b) => {
      if (a.id === recommendedVariantId) return -1;
      if (b.id === recommendedVariantId) return 1;
      return (b.scores?.overall ?? 0) - (a.scores?.overall ?? 0);
    });
    ranked.forEach((v, i) => {
      if (v.rank == null) v.rank = i + 1;
    });

    const comparisonMatrix = result.comparisonMatrix
      ?.map((row) => ({
        dimension: row.dimension,
        values: Object.fromEntries(
          Object.entries(row.values)
            .map(([key, value]) => [idByKey.get(key) ?? key, value])
            .filter(([key]) => variants.some((v) => v.id === key)),
        ),
      }))
      .filter((row) => Object.keys(row.values).length > 0);

    return {
      variants,
      recommendedVariantId,
      comparisonMatrix: comparisonMatrix && comparisonMatrix.length > 0 ? comparisonMatrix : undefined,
    };
  }

  private async tryGenerate(
    jdText: string,
    targetRole: string | undefined,
    experiences: ProductExperienceSummary[],
  ): Promise<z.infer<typeof NormalizedGenerationResultSchema>> {
    debugGeneration("initial start", { experienceCount: experiences.length, targetRole });
    let responseContent = "";
    try {
      const response = await this.modelClient.chat({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(jdText, targetRole, experiences) },
        ],
        temperature: 0.4,
        maxTokens: 8192,
        responseFormat: "json",
      });
      responseContent = response.content;
    } catch (error) {
      const providerErrorMessage = errorMessage(error);
      debugGeneration("initial provider failed", { providerErrorMessage });
      throw new LLMGenerationError(
        `LLM_GENERATION_FAILED: provider call failed during initial generation. ${providerErrorMessage}`,
        { phase: "provider_call", providerErrorMessage, cause: error },
      );
    }

    debugGeneration("initial raw content", { rawContentPreview: preview(responseContent) });

    // Parse JSON
    let parsed: unknown;
    try {
      parsed = parseJson(responseContent, "initial");
    } catch (error) {
      // JSON parse failed — try repair immediately
      return this.repairGeneration(jdText, targetRole, experiences, "json_parse", responseContent);
    }

    // Normalize (lenient) then validate (strict)
    const normalized = normalizeGenerationResult(parsed);
    if (normalized.variants.length > 0) {
      // Re-validate through strict schema — should always pass after normalization
      const validated = NormalizedGenerationResultSchema.safeParse(normalized);
      if (validated.success) {
        debugGeneration("initial success", { variantCount: validated.data.variants.length });
        return validated.data;
      }
      // Normalized data failed strict schema — this is unexpected, log and proceed
      const issues = formatIssues(validated.error.issues);
      debugGeneration("initial schema issues after normalize", { schemaIssues: issues });
      // Fall through to repair as last resort
    }

    // No valid variants after normalization — try repair
    return this.repairGeneration(jdText, targetRole, experiences, "schema_validation", responseContent, normalized.variants.length === 0
      ? ["no variants with non-empty content"]
      : formatIssues(NormalizedGenerationResultSchema.safeParse(normalized).error?.issues ?? []));
  }

  private async repairGeneration(
    jdText: string,
    targetRole: string | undefined,
    experiences: ProductExperienceSummary[],
    reason: "json_parse" | "schema_validation",
    previousContent: string,
    schemaIssues?: string[],
  ): Promise<z.infer<typeof NormalizedGenerationResultSchema>> {
    let responseContent = "";
    try {
      const errorSummary = (schemaIssues ?? ["JSON could not be parsed."])
        .slice(0, 6)
        .join("\n");

      const response = await this.modelClient.chat({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(jdText, targetRole, experiences) },
          { role: "assistant", content: "[previous output had schema errors]" },
          { role: "user", content: REPAIR_PROMPT.replace("{{errors}}", errorSummary) },
        ],
        temperature: 0.3,
        maxTokens: 8192,
        responseFormat: "json",
      });
      responseContent = response.content;
    } catch (error) {
      const providerErrorMessage = errorMessage(error);
      debugGeneration("repair provider failed", { providerErrorMessage });
      throw new LLMGenerationError(
        `LLM_GENERATION_FAILED: provider call failed during repair. ${providerErrorMessage}`,
        { phase: "provider_call", providerErrorMessage, cause: error },
      );
    }

    debugGeneration("repair raw content", { rawContentPreview: preview(responseContent) });

    // Parse + normalize + validate (same lenient flow as initial)
    let parsed: unknown;
    try {
      parsed = parseJson(responseContent, "repair");
    } catch (error) {
      throw new LLMGenerationError(
        `LLM_GENERATION_FAILED: no valid resume variants were produced after repair. JSON parse failed.`,
        { phase: "json_parse", rawContentPreview: preview(responseContent) },
      );
    }

    const normalized = normalizeGenerationResult(parsed);
    if (normalized.variants.length > 0) {
      const validated = NormalizedGenerationResultSchema.safeParse(normalized);
      if (validated.success) {
        debugGeneration("repair success", { variantCount: validated.data.variants.length });
        return validated.data;
      }
      const repairIssues = formatIssues(validated.error.issues);
      debugGeneration("repair schema issues after normalize", { schemaIssues: repairIssues });
      throw new LLMGenerationError(
        `LLM_GENERATION_FAILED: schema validation failed after repair and normalization. Schema issues: ${repairIssues.join("; ")}`,
        { phase: "schema_validation", rawContentPreview: preview(responseContent), schemaIssues: repairIssues },
      );
    }

    throw new LLMGenerationError(
      `LLM_GENERATION_FAILED: no valid resume variants were produced after repair and normalization.`,
      { phase: "schema_validation", rawContentPreview: preview(responseContent), schemaIssues: ["0 variants with non-empty content after repair"] },
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// JSON parsing
// ═══════════════════════════════════════════════════════════════

function parseJson(content: string, stage: "initial" | "repair"): unknown {
  const trimmed = content.trim();
  const candidates = extractJsonCandidates(trimmed).map((candidate) => candidate.text);
  const parseErrors: string[] = [];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      parseErrors.push(errorMessage(error));
    }
  }
  throw new LLMGenerationError(
    `LLM_GENERATION_FAILED: JSON parse failed during ${stage}. ${parseErrors[0] ?? "No JSON object or array found."}`,
    { phase: "json_parse", rawContentPreview: preview(content), providerErrorMessage: parseErrors[0] },
  );
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function formatIssues(issues: z.ZodIssue[]): string[] {
  return issues.slice(0, 8).map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function preview(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 800);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function debugGeneration(event: string, payload: Record<string, unknown>): void {
  if (process.env.NODE_ENV !== "development" && process.env.DEBUG_LLM_GENERATION !== "true") return;
  if (process.env.DEBUG_LLM_GENERATION === "false") return;
  console.debug("[llm-generation]", { event, ...payload });
}
