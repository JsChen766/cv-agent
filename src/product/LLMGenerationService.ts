import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ModelClient } from "../agent-core/model/ModelClient.js";
import { PromptRegistry } from "../agent-core/prompts/PromptRegistry.js";
import { extractJsonCandidates } from "../infrastructure/llm/JsonOutputParser.js";
import type { ProductExperienceSummary, ProductGeneratedVariant } from "./types.js";
import type { EvidencePack } from "../rag/evidence/index.js";

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
  };
}

function normalizeGenerationResult(raw: unknown): {
  variants: NormalizedVariant[];
} {
  if (Array.isArray(raw)) {
    return { variants: normalizeVariantList(raw) };
  }
  if (isRecord(raw)) {
    const variants = Array.isArray(raw.variants)
      ? normalizeVariantList(raw.variants)
      : [];
    return { variants };
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
});

const NormalizedGenerationResultSchema = z.object({
  variants: z.array(NormalizedVariantSchema).min(1).max(5),
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

function buildEvidenceGroundedUserPrompt(input: {
  jdText: string;
  targetRole?: string;
  evidencePack: EvidencePack;
}): string {
  const requirements = input.evidencePack.jdRequirements.map((requirement) => [
    `- [${requirement.id}] ${requirement.text}`,
    `  category=${requirement.category}; importance=${requirement.importance}; policies=${requirement.retrievalPolicies.join(",")}`,
  ].join("\n")).join("\n");

  const allowedClaims = input.evidencePack.allowedClaims.length > 0
    ? input.evidencePack.allowedClaims.map((claim) => [
        `- [${claim.id}] ${claim.claim}`,
        `  sourceExperienceId=${claim.experienceId}; confidence=${claim.confidence}; risk=${claim.riskLevel}`,
        `  evidence: ${claim.evidenceText}`,
      ].join("\n")).join("\n")
    : "NO ALLOWED CLAIMS AVAILABLE. Do not write unsupported factual claims.";

  const missing = input.evidencePack.missingRequirements.length > 0
    ? input.evidencePack.missingRequirements.map((item) => `- [${item.requirementId}] ${item.requirementText} (${item.recommendedAction}): ${item.reason}`).join("\n")
    : "No missing requirements detected by Evidence RAG.";

  const trace = input.evidencePack.retrievalTrace.slice(0, 12).map((item) => [
    `- ${item.title} [${item.experienceId}] score=${item.score}`,
    `  matched=${item.matchedTerms.join(", ") || "none"}; reason=${item.reason}`,
  ].join("\n")).join("\n");

  return [
    input.targetRole ? `Target role: ${input.targetRole}` : "",
    "",
    "Job Description:",
    input.jdText.slice(0, 4000),
    "",
    "Evidence RAG Version:",
    input.evidencePack.version,
    "",
    "JD Requirements:",
    requirements || "No structured JD requirements were extracted.",
    "",
    "Allowed Claims:",
    allowedClaims,
    "",
    "Missing or Weakly Supported Requirements:",
    missing,
    "",
    "Retrieval Trace:",
    trace || "No matching experiences retrieved.",
    "",
    "Hard factual boundary:",
    "- You may rephrase, prioritize, and package only the Allowed Claims.",
    "- Do NOT invent companies, roles, project names, metrics, skills, users, revenue, launches, leadership, or outcomes.",
    "- If a JD requirement has no allowed claim, list it in missingInfo or mark it as needing confirmation. Do not force it into the resume.",
    "- For each variant, sourceExperienceIds should refer only to experiences in the Evidence Pack.",
    "- Provide evidenceSummary and riskSummary based on the Evidence Pack.",
    "",
    "Generate resume content variants. Return a JSON object with a 'variants' array.",
  ].join("\n");
}

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
  ): Promise<ProductGeneratedVariant[]> {
    const result = await this.tryGenerate(jdText, targetRole, experiences);
    return this.toGeneratedVariants(userId, result.variants);
  }

  public async generateVariantsWithEvidenceContext(input: {
    userId: string;
    jdText: string;
    targetRole?: string;
    evidencePack: EvidencePack;
  }): Promise<ProductGeneratedVariant[]> {
    const userPrompt = buildEvidenceGroundedUserPrompt({
      jdText: input.jdText,
      targetRole: input.targetRole,
      evidencePack: input.evidencePack,
    });
    const result = await this.tryGenerateFromPrompt(userPrompt, {
      evidenceClaimCount: input.evidencePack.allowedClaims.length,
      missingRequirementCount: input.evidencePack.missingRequirements.length,
      targetRole: input.targetRole,
    });
    const variants = this.toGeneratedVariants(input.userId, result.variants);
    const fallbackExperienceIds = Array.from(new Set(input.evidencePack.allowedClaims.map((claim) => claim.experienceId))).slice(0, 12);
    const fallbackEvidenceIds = input.evidencePack.allowedClaims.map((claim) => claim.id).slice(0, 20);
    return variants.map((variant) => ({
      ...variant,
      sourceExperienceIds: variant.sourceExperienceIds && variant.sourceExperienceIds.length > 0
        ? variant.sourceExperienceIds
        : fallbackExperienceIds,
      sourceEvidenceIds: variant.sourceEvidenceIds && variant.sourceEvidenceIds.length > 0
        ? variant.sourceEvidenceIds
        : fallbackEvidenceIds,
      evidenceSummary: variant.evidenceSummary ?? buildDefaultEvidenceSummary(input.evidencePack),
      riskSummary: variant.riskSummary ?? buildDefaultRiskSummary(input.evidencePack),
      missingInfo: variant.missingInfo ?? input.evidencePack.missingRequirements.map((item) => `Confirm or add evidence for: ${item.requirementText}`).slice(0, 8),
    }));
  }

  private toGeneratedVariants(userId: string, variants: NormalizedVariant[]): ProductGeneratedVariant[] {
    const now = new Date().toISOString();
    return variants.map((variant) => ({
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
      createdAt: now,
    }));
  }

  private async tryGenerate(
    jdText: string,
    targetRole: string | undefined,
    experiences: ProductExperienceSummary[],
  ): Promise<z.infer<typeof NormalizedGenerationResultSchema>> {
    return this.tryGenerateFromPrompt(buildUserPrompt(jdText, targetRole, experiences), {
      experienceCount: experiences.length,
      targetRole,
    });
  }

  private async tryGenerateFromPrompt(
    userPrompt: string,
    debugPayload: Record<string, unknown>,
  ): Promise<z.infer<typeof NormalizedGenerationResultSchema>> {
    debugGeneration("initial start", debugPayload);
    let responseContent = "";
    try {
      const response = await this.modelClient.chat({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
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
      return this.repairGenerationFromPrompt(userPrompt, "json_parse", responseContent);
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
    return this.repairGenerationFromPrompt(userPrompt, "schema_validation", responseContent, normalized.variants.length === 0
      ? ["no variants with non-empty content"]
      : formatIssues(NormalizedGenerationResultSchema.safeParse(normalized).error?.issues ?? []));
  }

  private async repairGenerationFromPrompt(
    userPrompt: string,
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
          { role: "user", content: userPrompt },
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


function buildDefaultEvidenceSummary(evidencePack: EvidencePack): ProductGeneratedVariant["evidenceSummary"] {
  return {
    coverageLabel: evidencePack.missingRequirements.length > 0
      ? `Evidence Pack covers ${Math.max(0, evidencePack.jdRequirements.length - evidencePack.missingRequirements.length)} of ${evidencePack.jdRequirements.length} JD requirements.`
      : "Evidence Pack provides verified claims for the JD requirements.",
    items: evidencePack.allowedClaims.slice(0, 6).map((claim) => ({
      id: claim.id,
      title: claim.claim.slice(0, 80),
      explanation: `Supported by ${claim.experienceId}: ${claim.evidenceText}`,
      confidence: claim.confidence,
    })),
  };
}

function buildDefaultRiskSummary(evidencePack: EvidencePack): ProductGeneratedVariant["riskSummary"] {
  const weakSignals = evidencePack.qualitySignals.filter((signal) => signal.quality === "weak" || signal.quality === "missing");
  return {
    level: evidencePack.missingRequirements.length > 0 ? "medium" : "low",
    unsupportedClaims: [],
    missingEvidence: evidencePack.missingRequirements.map((item) => item.requirementText).slice(0, 8),
    warnings: weakSignals.map((signal) => signal.reason).slice(0, 6),
  };
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
