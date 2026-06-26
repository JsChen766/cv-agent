import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ModelClient } from "../agent-core/model/ModelClient.js";
import { PromptRegistry } from "../agent-core/prompts/PromptRegistry.js";
import { extractJsonCandidates } from "../infrastructure/llm/JsonOutputParser.js";
import type { ProductExperienceSummary, ProductGeneratedVariant, ResumeDocument, VariantComparisonMatrixRow } from "./types.js";
import type { EvidencePack } from "../rag/evidence/index.js";
import type { InstructionPack } from "../rag/guideline/index.js";
import type { GroundingContext } from "../rag/types.js";
import type { PersonalizationPack } from "../self-evolution/preference/index.js";

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
  return Array.from(new Set(raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim())));
}

function normalizeStringIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(new Set(raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim())));
}


function normalizeGroundingTrace(raw: unknown): ProductGeneratedVariant["groundingTrace"] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const traces = raw.flatMap((item) => {
    if (!isRecord(item) || typeof item.text !== "string") return [];
    const support: "supported" | "partial" | "unsupported" = item.support === "supported" || item.support === "partial" || item.support === "unsupported"
      ? item.support
      : "partial";
    return [{
      text: item.text.trim(),
      support,
      claimIds: normalizeStringIds(item.claimIds),
      experienceIds: normalizeStringIds(item.experienceIds),
      confidence: normalizeScore(item.confidence ?? 0.5),
      reason: typeof item.reason === "string" ? item.reason.trim() : "Provided by the generator.",
    }];
  }).filter((item) => item.text.length > 0);
  return traces.length > 0 ? traces : undefined;
}

// ───────────────────────────────────────────────────────────────
// Optional structured ResumeDocument — Phase 3
// ───────────────────────────────────────────────────────────────
//
// The LLM MAY also return a structured `resumeDocument` alongside the plain
// `content` string. We validate it strictly with zod; any failure (missing,
// malformed, empty sections, …) silently drops the field. The unstructured
// `content` remains authoritative — the saver in `services/index.ts` only
// uses `resumeDocument` when it is present *and* its sections array is
// non-empty, otherwise it keeps the legacy single-item behaviour.

const ResumeDocumentBulletSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  evidenceIds: z.array(z.string()).optional(),
});

const ResumeDocumentItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  period: z.string().optional(),
  location: z.string().optional(),
  bullets: z.array(ResumeDocumentBulletSchema),
  sourceExperienceId: z.string().optional(),
  evidenceStrength: z.enum(["low", "medium", "high"]).optional(),
  relevanceScore: z.number().min(0).max(1).optional(),
});

const ResumeDocumentSectionSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["experience", "education", "project", "skill", "award", "summary", "other"]),
  title: z.string().min(1),
  order: z.number().int().nonnegative(),
  items: z.array(ResumeDocumentItemSchema),
});

const ResumeDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  sections: z.array(ResumeDocumentSectionSchema).min(1),
});

function normalizeResumeDocument(raw: unknown): ResumeDocument | undefined {
  if (raw == null) return undefined;
  const parsed = ResumeDocumentSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  return parsed.data;
}

function inferResumeDocumentFromContent(
  content: string,
  sourceExperienceIds: string[],
  sourceEvidenceIds: string[],
): ResumeDocument | undefined {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\*\*(.+)\*\*$/, "$1"))
    .filter(Boolean);
  const sections: ResumeDocument["sections"] = [];
  let current: ResumeDocument["sections"][number] | undefined;
  let currentItem: ResumeDocument["sections"][number]["items"][number] | undefined;
  let recognizedHeadingCount = 0;

  const ensureSection = (title: string): ResumeDocument["sections"][number] => {
    const type = sectionTypeFromTitle(title);
    const section: ResumeDocument["sections"][number] = {
      id: `sec-${sections.length + 1}`,
      type,
      title,
      order: sections.length,
      items: [],
    };
    sections.push(section);
    current = section;
    currentItem = undefined;
    return section;
  };

  for (const line of lines) {
    const heading = normalizeSectionHeading(line);
    if (heading) {
      recognizedHeadingCount += 1;
      ensureSection(heading);
      continue;
    }
    if (!current) ensureSection("其他");
    const bullet = line.replace(/^[-*•]\s*/, "").trim();
    if (/^[-*•]\s+/.test(line)) {
      if (!currentItem) {
        currentItem = makeResumeDocumentItem(current!, current!.title, sourceExperienceIds[0]);
        current!.items.push(currentItem);
      }
      currentItem.bullets.push({
        id: `b-${currentItem.bullets.length + 1}`,
        text: bullet,
        evidenceIds: sourceEvidenceIds.slice(0, 4),
      });
      continue;
    }
    currentItem = makeResumeDocumentItem(current!, line, sourceExperienceIds[current!.items.length] ?? sourceExperienceIds[0]);
    current!.items.push(currentItem);
  }

  const usableSections = sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => item.title.trim() || item.bullets.length > 0),
    }))
    .filter((section) => section.items.length > 0);
  if (usableSections.length === 0 || recognizedHeadingCount < 2) return undefined;
  return { schemaVersion: 1, sections: usableSections };
}

function normalizeSectionHeading(line: string): string | undefined {
  const normalized = line.replace(/[:：]$/, "").trim();
  const headings = ["教育经历", "技能与兴趣", "技能", "实习经历", "工作经历", "项目经历", "荣誉奖项", "个人总结", "求职亮点"];
  return headings.find((heading) => normalized === heading);
}

function sectionTypeFromTitle(title: string): ResumeDocument["sections"][number]["type"] {
  if (title.includes("教育")) return "education";
  if (title.includes("技能")) return "skill";
  if (title.includes("实习") || title.includes("工作")) return "experience";
  if (title.includes("项目")) return "project";
  if (title.includes("荣誉") || title.includes("奖")) return "award";
  if (title.includes("总结") || title.includes("亮点")) return "summary";
  return "other";
}

function makeResumeDocumentItem(
  section: ResumeDocument["sections"][number],
  title: string,
  sourceExperienceId: string | undefined,
): ResumeDocument["sections"][number]["items"][number] {
  const item: ResumeDocument["sections"][number]["items"][number] = {
    id: `item-${section.items.length + 1}`,
    title: title.slice(0, 120) || section.title,
    bullets: [],
  };
  if (sourceExperienceId) item.sourceExperienceId = sourceExperienceId;
  return item;
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
  const sourceExperienceIds = normalizeStringIds(raw.sourceExperienceIds);
  const sourceEvidenceIds = normalizeStringIds(raw.sourceEvidenceIds);
  const resumeDocument = normalizeResumeDocument(raw.resumeDocument ?? raw.document ?? raw.structuredResume)
    ?? inferResumeDocumentFromContent(content, sourceExperienceIds, sourceEvidenceIds);

  return {
    content,
    scores,
    reason: typeof raw.reason === "string" && raw.reason.trim()
      ? raw.reason.trim()
      : "Generated based on JD and experience library.",
    sourceExperienceIds,
    sourceEvidenceIds,
    evidenceSummary: normalizeEvidenceSummary(raw.evidenceSummary),
    riskSummary: normalizeRiskSummary(raw.riskSummary),
    missingInfo: normalizeMissingInfo(raw.missingInfo),
    groundingTrace: normalizeGroundingTrace(raw.groundingTrace),
    variantName: normalizeShortString(raw.variantName ?? raw.name, 12),
    summary: normalizeShortString(raw.summary ?? raw.summaryLine, 32),
    scenario: normalizeShortString(raw.scenario ?? raw.position, 14),
    advantages: normalizeStringArray(raw.advantages ?? raw.strengths ?? raw.pros, 4, 14),
    risks: normalizeStringArray(raw.risks ?? raw.cautions ?? raw.cons, 3, 18),
    recommended: normalizeBool(raw.recommended ?? raw.preferred ?? raw.isRecommended),
    rank: normalizeRank(raw.rank),
    resumeDocument,
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
  sourceEvidenceIds: string[];
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
  groundingTrace?: ProductGeneratedVariant["groundingTrace"];
  variantName?: string;
  summary?: string;
  scenario?: string;
  advantages?: string[];
  risks?: string[];
  recommended?: boolean;
  rank?: number;
  resumeDocument?: ResumeDocument;
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
  sourceEvidenceIds: z.array(z.string()),
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
  groundingTrace: z.array(z.object({
    text: z.string(),
    support: z.enum(["supported", "partial", "unsupported"]),
    claimIds: z.array(z.string()),
    experienceIds: z.array(z.string()),
    confidence: z.number().min(0).max(1),
    reason: z.string(),
  })).optional(),
  variantName: z.string().optional(),
  summary: z.string().optional(),
  scenario: z.string().optional(),
  advantages: z.array(z.string()).optional(),
  risks: z.array(z.string()).optional(),
  recommended: z.boolean().optional(),
  rank: z.number().int().positive().optional(),
  resumeDocument: ResumeDocumentSchema.optional(),
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

function buildEvidenceGroundedUserPrompt(input: {
  jdText: string;
  targetRole?: string;
  evidencePack: EvidencePack;
  sourceExperiences?: ProductExperienceSummary[];
  instructionPack?: InstructionPack;
  groundingContext?: GroundingContext;
  personalizationPack?: PersonalizationPack;
}): string {
  const requirements = input.evidencePack.jdRequirements.map((requirement) => [
    `- [${requirement.id}] ${requirement.text}`,
    `  category=${requirement.category}; importance=${requirement.importance}; policies=${requirement.retrievalPolicies.join(",")}`,
  ].join("\n")).join("\n");

  const allowedClaims = input.evidencePack.allowedClaims.length > 0
    ? input.evidencePack.allowedClaims.map((claim) => [
        `- [${claim.claimId ?? claim.id}] ${claim.claim}`,
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

  const sourceCards = buildSourceExperienceCards(input.sourceExperiences ?? []);

  const longTermMemory = input.evidencePack.longTermMemory ? [
    "Claim Usage Stats:",
    input.evidencePack.longTermMemory.claimUsageStats.slice(0, 12).map((item) => `- ${item.claimId}: accepted=${item.acceptedCount}, edited=${item.editedCount}, rejected=${item.rejectedCount}, acceptanceRate=${item.acceptanceRate.toFixed(2)}`).join("\n") || "No prior claim usage stats.",
    "",
    "Role-specific Effectiveness:",
    input.evidencePack.longTermMemory.roleSpecificEffectiveness.slice(0, 12).map((item) => `- ${item.roleFamily}/${item.claimId}: score=${item.effectivenessScore}, accepted=${item.acceptedCount}, outcomes=${item.outcomePositiveCount}`).join("\n") || "No role-specific effectiveness data.",
  ].join("\n") : "No long-term evidence memory yet.";

  const instruction = input.instructionPack ? [
    "Instruction Pack Version:",
    input.instructionPack.version,
    "",
    "Target Positioning:",
    input.instructionPack.targetPositioning,
    "",
    "Role-aware Priority Requirements:",
    input.instructionPack.priorityRequirements.length > 0 ? input.instructionPack.priorityRequirements.map((item) => `- ${item}`).join("\n") : "No guideline priority requirements.",
    "",
    "Section Strategy:",
    Object.entries(input.instructionPack.sectionStrategy).filter(([, value]) => Boolean(value)).map(([key, value]) => `- ${key}: ${value}`).join("\n") || "No section strategy provided.",
    "",
    "Writing Rules:",
    input.instructionPack.writingRules.map((item) => `- ${item}`).join("\n") || "No extra writing rules.",
    "",
    "Negative Constraints:",
    input.instructionPack.negativeConstraints.map((item) => `- ${item}`).join("\n") || "No extra negative constraints.",
    "",
    "Example Patterns:",
    input.instructionPack.examplePatterns.slice(0, 6).map((item) => `- ${item.useCase}: ${item.pattern}`).join("\n") || "No example patterns.",
  ].join("\n") : "No Instruction Pack available. Use only general resume-writing rules and the Evidence Pack.";


  const personalization = input.personalizationPack ? [
    `PreferenceBank Version: ${input.personalizationPack.version}`,
    "Stable Preferences:",
    input.personalizationPack.stablePreferences.map((item) => `- ${item.instruction} (confidence=${item.confidence.toFixed(2)})`).join("\n") || "No stable preferences.",
    "",
    "Contextual Preferences:",
    input.personalizationPack.contextualPreferences.map((item) => `- ${item.instruction} (confidence=${item.confidence.toFixed(2)})`).join("\n") || "No contextual preferences.",
    "",
    "Negative Preferences:",
    input.personalizationPack.negativePreferences.map((item) => `- Avoid or downweight: ${item.instruction}`).join("\n") || "No negative preferences.",
    "",
    "Experience Affinities:",
    input.personalizationPack.experienceAffinities.map((item) => `- ${item.experienceId}: affinity=${item.affinity.toFixed(2)}; ${item.reason}`).join("\n") || "No learned experience affinities.",
    "",
    "Preference policy:",
    "- Treat preferences as soft personalization constraints.",
    "- Current explicit user instructions override retrieved preferences.",
    "- Evidence and hard factual constraints always override style or selection preferences.",
    "- Do not apply uncertain preferences as requirements.",
  ].join("\n") : "No PreferenceBank context available yet.";

  const coordinatedPlan = input.groundingContext ? [
    `Coverage: supported=${input.groundingContext.coverageSummary.supportedRequirements}, partial=${input.groundingContext.coverageSummary.partiallySupportedRequirements}, missing=${input.groundingContext.coverageSummary.missingRequirements}`,
    ...input.groundingContext.requirementPlan.slice(0, 20).map((item) =>
      `- [${item.requirementId}] ${item.action}: ${item.text}; claimIds=${item.claimIds.join(",") || "none"}`
    ),
    ...input.groundingContext.executionRules.map((rule) => `RULE: ${rule}`),
  ].join("\n") : "No coordinated grounding plan available.";

  return [
    input.targetRole ? `Target role: ${input.targetRole}` : "",
    "",
    "Job Description:",
    input.jdText.slice(0, 4000),
    "",
    "Guideline / Instruction Context:",
    instruction,
    "",
    "Coordinated Requirement Plan:",
    coordinatedPlan,
    "",
    "User Preference Context:",
    personalization,
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
    "Candidate Source Cards (authoritative resume facts):",
    sourceCards || "No source cards were provided. Use only Allowed Claims.",
    "",
    "Missing or Weakly Supported Requirements:",
    missing,
    "",
    "Retrieval Trace:",
    trace || "No matching experiences retrieved.",
    "",
    "Long-Term Evidence Memory:",
    longTermMemory,
    "",
    "Grounding policy:",
    "- Follow the Instruction Pack for writing strategy, role positioning, and style.",
    "- Treat the Evidence Pack as the factual boundary.",
    "- You may rephrase, prioritize, and package only the Allowed Claims.",
    "- Do NOT invent companies, roles, project names, metrics, skills, users, revenue, launches, leadership, or outcomes.",
    "- If a JD requirement has no allowed claim, list it in missingInfo or mark it as needing confirmation. Do not force it into the resume.",
    "- For each variant, sourceExperienceIds must include only experiences actually used in its content.",
    "- For each variant, sourceEvidenceIds must contain the exact persistent claim IDs shown in square brackets for claims actually used.",
    "- Do not attach every retrieved claim to every variant. Return only directly used claims.",
    "- Provide evidenceSummary and riskSummary based on the Evidence Pack.",
    "- Use exact organization, role/title, school, dates, and project names from Candidate Source Cards. If a field is missing, omit it; never write placeholders such as 某公司, 某科技公司, or guessed dates.",
    "- The recommended variant must read like a complete one-page resume body, not a short analysis summary. Use plain Chinese section headings such as 教育经历, 技能与兴趣, 实习经历, 项目经历.",
    "- Match the reference resume density: concise high-signal bullets, action + method/technology + scope + verified metric/result, usually 2-5 bullets per selected experience/project.",
    "- Tailor selection and bullet ordering to the JD. Prefer the most relevant 4-6 source experiences over listing everything.",
    "- Avoid obvious AI resume filler such as 具备较强, 良好的, 扎实的, 积极主动, 学习能力强 unless directly supported by evidence.",
    "- Include a valid resumeDocument for every variant whenever possible; it must mirror the plain content and preserve sourceExperienceId/evidenceIds.",
    "",
    "Generate resume content variants. Return a JSON object with a 'variants' array.",
  ].join("\n");
}

function buildSourceExperienceCards(experiences: ProductExperienceSummary[]): string {
  return experiences.slice(0, 12).map((exp) => {
    const structured = compactStructuredExperience(exp.structured);
    const dates = [exp.startDate, exp.endDate].filter(Boolean).join(" - ");
    return [
      `- sourceExperienceId=${exp.id}`,
      `  category=${exp.category}; title=${exp.title}`,
      exp.organization ? `  organization=${exp.organization}` : "",
      exp.role ? `  role=${exp.role}` : "",
      dates ? `  dates=${dates}` : "",
      structured.techStack.length > 0 ? `  techStack=${structured.techStack.join(", ")}` : "",
      structured.metrics.length > 0 ? `  metrics=${structured.metrics.join(" | ")}` : "",
      structured.highlights.length > 0 ? `  highlights=${structured.highlights.join(" | ")}` : "",
      exp.content ? `  content=${exp.content.replace(/\s+/g, " ").trim().slice(0, 900)}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

function compactStructuredExperience(structured: Record<string, unknown> | undefined): {
  techStack: string[];
  metrics: string[];
  highlights: string[];
} {
  if (!structured) return { techStack: [], metrics: [], highlights: [] };
  const techStack = stringList(structured.techStack).slice(0, 12);
  const highlights = stringList(structured.highlights).map((item) => item.slice(0, 180)).slice(0, 6);
  const metrics = Array.isArray(structured.metrics)
    ? structured.metrics.flatMap((item) => {
        if (!isRecord(item)) return [];
        const name = typeof item.name === "string" ? item.name.trim() : "";
        const value = typeof item.value === "string" || typeof item.value === "number" ? String(item.value).trim() : "";
        const context = typeof item.context === "string" ? item.context.trim() : "";
        const text = [name, value, context].filter(Boolean).join(": ");
        return text ? [text.slice(0, 160)] : [];
      }).slice(0, 10)
    : [];
  return { techStack, metrics, highlights };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

// ═══════════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════════

export type LLMGeneratedVariantsResult = {
  variants: ProductGeneratedVariant[];
  recommendedVariantId?: string;
  comparisonMatrix?: VariantComparisonMatrixRow[];
};

function buildFallbackComparisonMatrix(
  variants: ProductGeneratedVariant[],
  recommendedVariantId: string | undefined,
): VariantComparisonMatrixRow[] {
  if (variants.length === 0) return [];
  const dimensions = [
    { key: "recommendation", label: "推荐理由" },
    { key: "jdMatch", label: "JD 匹配度" },
    { key: "evidence", label: "证据强度" },
    { key: "risk", label: "风险" },
    { key: "scenario", label: "适用场景" },
  ];
  return dimensions.map((dim) => {
    const values: Record<string, string> = {};
    for (const v of variants) {
      switch (dim.key) {
        case "recommendation":
          values[v.id] = v.id === recommendedVariantId ? "推荐" : v.summary?.slice(0, 8) ?? "备选";
          break;
        case "jdMatch":
          values[v.id] = v.scores?.relevance != null ? `${Math.round(v.scores.relevance * 100)}%` : "—";
          break;
        case "evidence":
          values[v.id] = v.scores?.evidenceStrength != null ? `${Math.round(v.scores.evidenceStrength * 100)}%` : "—";
          break;
        case "risk":
          values[v.id] = v.riskSummary?.level ?? "—";
          break;
        case "scenario":
          values[v.id] = v.scenario?.slice(0, 8) ?? v.variantName?.slice(0, 8) ?? "—";
          break;
        default:
          values[v.id] = "—";
      }
    }
    return { dimension: dim.label, values };
  });
}

export class LLMGenerationService {
  public constructor(private readonly modelClient: ModelClient) {}

  public async generateVariants(
    userId: string,
    jdText: string,
    targetRole: string | undefined,
    experiences: ProductExperienceSummary[],
  ): Promise<LLMGeneratedVariantsResult> {
    const result = await this.tryGenerate(jdText, targetRole, experiences);
    return this.toGeneratedResult(userId, result);
  }

  public async generateVariantsWithEvidenceContext(input: {
    userId: string;
    jdText: string;
    targetRole?: string;
    evidencePack: EvidencePack;
  }): Promise<LLMGeneratedVariantsResult> {
    return this.generateVariantsWithGroundingContext(input);
  }

  public async generateVariantsWithGroundingContext(input: {
    userId: string;
    jdText: string;
    targetRole?: string;
    evidencePack?: EvidencePack;
    sourceExperiences?: ProductExperienceSummary[];
    instructionPack?: InstructionPack;
    groundingContext?: GroundingContext;
    personalizationPack?: PersonalizationPack;
  }): Promise<LLMGeneratedVariantsResult> {
    if (!input.evidencePack) {
      const result = await this.tryGenerateFromPrompt(
        buildUserPrompt(input.jdText, input.targetRole, []),
        {
          targetRole: input.targetRole,
          guidelineOnly: Boolean(input.instructionPack),
        },
      );
      return this.toGeneratedResult(input.userId, result);
    }

    const evidencePack = input.evidencePack;
    const userPrompt = buildEvidenceGroundedUserPrompt({
      jdText: input.jdText,
      targetRole: input.targetRole,
      evidencePack,
      sourceExperiences: input.sourceExperiences,
      instructionPack: input.instructionPack,
      groundingContext: input.groundingContext,
      personalizationPack: input.personalizationPack,
    });
    const result = await this.tryGenerateFromPrompt(userPrompt, {
      evidenceClaimCount: evidencePack.allowedClaims.length,
      missingRequirementCount: evidencePack.missingRequirements.length,
      guidelineRuleCount: input.instructionPack?.writingRules.length ?? 0,
      preferenceCount: (input.personalizationPack?.stablePreferences.length ?? 0)
        + (input.personalizationPack?.contextualPreferences.length ?? 0),
      targetRole: input.targetRole,
    });

    const generated = this.toGeneratedResult(input.userId, result);
    const fallbackExperienceIds = Array.from(
      new Set(evidencePack.allowedClaims.map((claim) => claim.experienceId)),
    ).slice(0, 12);
    const fallbackEvidenceIds = evidencePack.allowedClaims
      .map((claim) => claim.claimId ?? claim.id)
      .slice(0, 20);

    return {
      ...generated,
      variants: generated.variants.map((variant) => ({
        ...variant,
        sourceExperienceIds:
          variant.sourceExperienceIds && variant.sourceExperienceIds.length > 0
            ? variant.sourceExperienceIds
            : fallbackExperienceIds,
        sourceEvidenceIds:
          variant.sourceEvidenceIds && variant.sourceEvidenceIds.length > 0
            ? variant.sourceEvidenceIds
            : fallbackEvidenceIds,
        evidenceSummary:
          variant.evidenceSummary ?? buildDefaultEvidenceSummary(evidencePack),
        riskSummary:
          variant.riskSummary ?? buildDefaultRiskSummary(evidencePack),
        missingInfo:
          variant.missingInfo ??
          evidencePack.missingRequirements
            .map((item) => `Confirm or add evidence for: ${item.requirementText}`)
            .slice(0, 8),
      })),
    };
  }

  private toGeneratedResult(
    userId: string,
    result: z.infer<typeof NormalizedGenerationResultSchema>,
  ): LLMGeneratedVariantsResult {
    const now = new Date().toISOString();
    const variants: ProductGeneratedVariant[] = result.variants.map((variant) => ({
      id: `pvar-${randomUUID()}`,
      userId,
      content: variant.content,
      reason: variant.reason,
      sourceExperienceIds: variant.sourceExperienceIds ?? [],
      sourceEvidenceIds: variant.sourceEvidenceIds ?? [],
      scores: {
        overall: variant.scores.overall,
        relevance: variant.scores.relevance,
        evidenceStrength: variant.scores.evidenceStrength,
        ...(variant.scores.quantifiedImpact != null
          ? { quantifiedImpact: variant.scores.quantifiedImpact }
          : {}),
        ...(variant.scores.clarity != null
          ? { clarity: variant.scores.clarity }
          : {}),
      },
      evidenceSummary: variant.evidenceSummary,
      riskSummary: variant.riskSummary,
      missingInfo: variant.missingInfo,
      groundingTrace: variant.groundingTrace,
      variantName: variant.variantName,
      summary: variant.summary,
      scenario: variant.scenario,
      advantages: variant.advantages,
      risks: variant.risks,
      recommended: variant.recommended,
      rank: variant.rank,
      resumeDocument: variant.resumeDocument,
      createdAt: now,
    }));

    const idByKey = new Map<string, string>();
    variants.forEach((variant, index) => {
      idByKey.set(`v${index}`, variant.id);
      idByKey.set(String(index), variant.id);
      idByKey.set(variant.id, variant.id);
    });

    const recommendedFromLlm = result.recommendedVariantKey
      ? idByKey.get(result.recommendedVariantKey)
      : undefined;
    const recommendedFromFlag = variants.find((variant) => variant.recommended)?.id;
    const recommendedByScore = (() => {
      if (variants.length === 0) return undefined;
      let best = variants[0];
      for (const variant of variants) {
        if ((variant.scores?.overall ?? 0) > (best.scores?.overall ?? 0)) {
          best = variant;
        }
      }
      return best.id;
    })();
    const recommendedVariantId =
      recommendedFromLlm ?? recommendedFromFlag ?? recommendedByScore;

    if (recommendedVariantId) {
      for (const variant of variants) {
        variant.recommended = variant.id === recommendedVariantId;
      }
    }

    const ranked = [...variants].sort((a, b) => {
      if (a.id === recommendedVariantId) return -1;
      if (b.id === recommendedVariantId) return 1;
      return (b.scores?.overall ?? 0) - (a.scores?.overall ?? 0);
    });
    ranked.forEach((variant, index) => {
      if (variant.rank == null) variant.rank = index + 1;
    });

    const comparisonMatrix = result.comparisonMatrix
      ?.map((row) => ({
        dimension: row.dimension,
        values: Object.fromEntries(
          Object.entries(row.values)
            .map(([key, value]) => [idByKey.get(key) ?? key, value])
            .filter(([key]) => variants.some((variant) => variant.id === key)),
        ),
      }))
      .filter((row) => Object.keys(row.values).length > 0);

    const fallbackComparisonMatrix = comparisonMatrix && comparisonMatrix.length > 0
      ? comparisonMatrix
      : buildFallbackComparisonMatrix(variants, recommendedVariantId);

    return {
      variants,
      recommendedVariantId,
      comparisonMatrix: fallbackComparisonMatrix,
    };
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
        maxTokens: 12000,
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
        maxTokens: 12000,
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
