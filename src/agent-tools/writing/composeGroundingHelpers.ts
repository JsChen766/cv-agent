import type { AgentContext } from "../../agent-core/runtime/AgentContext.js";
import type { EvidencePack } from "../../rag/evidence/types.js";
import type { InstructionPack } from "../../rag/guideline/types.js";
import type { PersonalizationPack, PreferenceInstruction } from "../../self-evolution/preference/types.js";

/**
 * Phase 4 grounding helpers for compose_career_text.
 *
 * Centralizes:
 *   1. bounded timeouts on RAG calls (chat hot-path must never stall);
 *   2. stable diagnostic tokens (so failures surface in warnings/riskNotes
 *      instead of being silently dropped);
 *   3. scope-aware filtering for PreferenceBank;
 *   4. an experience-grounded fallback path so EvidenceRAG can be invoked
 *      even when no JD is supplied;
 *   5. style-only consumption of GuidelineRAG with hard filtering of any
 *      rule that smells like an unverified factual claim.
 *
 * These helpers never fabricate data: when a service is missing or fails, the
 * caller receives a diagnostics object describing the failure and either no
 * pack or an empty pack. The writing tool then degrades gracefully.
 */

export type ResolvedExperienceLite = {
  id: string;
  title: string;
  organization?: string;
  role?: string;
  tags: string[];
  content: string;
};

export type GroundingDiagnostics = {
  evidenceRag: {
    status:
      | "skipped_no_signal"
      | "skipped_no_service"
      | "ok"
      | "ok_empty"
      | "unavailable"
      | "timeout";
    trigger: "jd" | "experience" | "none";
    detail?: string;
  };
  guidelineRag: {
    status:
      | "skipped_no_service"
      | "skipped_no_signal"
      | "ok"
      | "ok_empty"
      | "unavailable"
      | "timeout";
    detail?: string;
    filteredFactBearingCount: number;
  };
  preferenceBank: {
    status: "skipped_no_service" | "ok" | "ok_empty" | "unavailable";
    appliedCount: number;
    appliedPreferenceIds: string[];
    filteredByOutputType: number;
  };
};

const RAG_TIMEOUT_MS = 6_000;
const TIMEOUT_SENTINEL = Symbol("compose_career_text:timeout");

type RaceResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "timeout" | "error"; detail?: string };

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<RaceResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raced = await Promise.race<T | typeof TIMEOUT_SENTINEL>([
      promise,
      new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), ms);
      }),
    ]);
    if (raced === TIMEOUT_SENTINEL) return { ok: false, reason: "timeout" };
    return { ok: true, value: raced as T };
  } catch (error) {
    return {
      ok: false,
      reason: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// -------------------- PreferenceBank --------------------

export async function buildPersonalizationOutcome(
  context: AgentContext,
  options: { language: "zh" | "en" | "auto"; outputType: string; tone?: string },
): Promise<{ pack?: PersonalizationPack; diagnostics: GroundingDiagnostics["preferenceBank"] }> {
  const service = context.kernel.productServices.preferenceBankService;
  if (!service) {
    return {
      diagnostics: {
        status: "skipped_no_service",
        appliedCount: 0,
        appliedPreferenceIds: [],
        filteredByOutputType: 0,
      },
    };
  }
  try {
    const scope = options.language && options.language !== "auto" ? { language: options.language } : undefined;
    const raw = await service.buildPersonalizationPack({
      userId: context.userId,
      context: scope,
      limit: 10,
    });
    const filtered = filterPreferencesForOutputType(raw, options.outputType, options.tone);
    return {
      pack: filtered.pack,
      diagnostics: {
        status: filtered.pack.diagnostics.appliedCount === 0 ? "ok_empty" : "ok",
        appliedCount: filtered.pack.diagnostics.appliedCount,
        appliedPreferenceIds: filtered.appliedIds,
        filteredByOutputType: filtered.removedCount,
      },
    };
  } catch {
    return {
      diagnostics: {
        status: "unavailable",
        appliedCount: 0,
        appliedPreferenceIds: [],
        filteredByOutputType: 0,
      },
    };
  }
}

/**
 * Phase 4 - output-type-aware preference filter.
 *
 * Short writing flavors (self-intro, pitch, profile_summary, etc.) do not
 * benefit from section_order style preferences which only apply to a full
 * resume. We narrow the pack accordingly. The filter never invents
 * preferences; it can only drop existing items.
 */
function filterPreferencesForOutputType(
  pack: PersonalizationPack,
  outputType: string,
  tone?: string,
): { pack: PersonalizationPack; appliedIds: string[]; removedCount: number } {
  const SHORT_FLAVORS = new Set([
    "self_intro",
    "interview_answer",
    "pitch",
    "profile_summary",
    "application_answer",
    "project_intro",
  ]);
  const isShortFlavor = SHORT_FLAVORS.has(outputType);
  const keep = (item: PreferenceInstruction) => {
    if (isShortFlavor && item.dimension === "section_order") return false;
    if (isFactBearingStyleText(item.instruction)) return false;
    if (tone && namesDifferentTone(item.instruction, tone)) return false;
    return true;
  };
  const splitList = (list: PreferenceInstruction[]) => {
    const kept: PreferenceInstruction[] = [];
    let removed = 0;
    for (const item of list) {
      if (keep(item)) kept.push(item);
      else removed += 1;
    }
    return { kept, removed };
  };
  const stable = splitList(pack.stablePreferences);
  const contextual = splitList(pack.contextualPreferences);
  const negative = splitList(pack.negativePreferences);
  const removedCount = stable.removed + contextual.removed + negative.removed;
  const appliedIds = [
    ...stable.kept.map((p) => p.preferenceId),
    ...contextual.kept.map((p) => p.preferenceId),
    ...negative.kept.map((p) => p.preferenceId),
  ];
  const appliedCount = stable.kept.length + contextual.kept.length + negative.kept.length;
  const next: PersonalizationPack = {
    ...pack,
    stablePreferences: stable.kept,
    contextualPreferences: contextual.kept,
    negativePreferences: negative.kept,
    diagnostics: {
      ...pack.diagnostics,
      appliedCount,
      warnings: removedCount > 0
        ? [
            ...pack.diagnostics.warnings,
            "compose_career_text filtered " + String(removedCount)
              + " preference(s) outside outputType/tone/style-only boundary for outputType=" + outputType + ".",
          ]
        : pack.diagnostics.warnings,
    },
  };
  return { pack: next, appliedIds, removedCount };
}

function isFactBearingStyleText(value: string): boolean {
  return /(\d{2,})|(\d+%)|(\b(19|20)\d{2}\b)|("[^"]{2,}")|(\u201c[^\u201d]{2,}\u201d)/u.test(value);
}

function namesDifferentTone(instruction: string, requestedTone: string): boolean {
  const normalizedInstruction = normalizeTextToken(instruction);
  const normalizedTone = normalizeTextToken(requestedTone);
  if (!normalizedTone) return false;
  const knownTones = ["concise", "warm", "formal", "technical", "confident", "conservative", "casual"];
  return knownTones.some((tone) => tone !== normalizedTone && normalizedInstruction.includes(tone))
    && !normalizedInstruction.includes(normalizedTone);
}

function normalizeTextToken(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// -------------------- Evidence RAG --------------------

export async function buildEvidenceOutcome(
  context: AgentContext,
  input: { jdText?: string; experiences: ResolvedExperienceLite[] },
): Promise<{ pack?: EvidencePack; diagnostics: GroundingDiagnostics["evidenceRag"] }> {
  const service = context.kernel.productServices.evidenceRAGService;
  if (!service) {
    return { diagnostics: { status: "skipped_no_service", trigger: "none" } };
  }
  const jdText = input.jdText && input.jdText.trim().length > 0 ? input.jdText.trim() : undefined;
  const experienceIds = input.experiences.map((e) => e.id);
  let trigger: GroundingDiagnostics["evidenceRag"]["trigger"] = "none";
  let pseudoJDText: string | undefined;

  if (jdText) {
    trigger = "jd";
  } else if (experienceIds.length > 0) {
    pseudoJDText = synthesizePseudoJDFromExperiences(input.experiences);
    if (pseudoJDText && pseudoJDText.length >= 40) {
      trigger = "experience";
    } else {
      return { diagnostics: { status: "skipped_no_signal", trigger: "none" } };
    }
  } else {
    return { diagnostics: { status: "skipped_no_signal", trigger: "none" } };
  }

  const requestedJDText = expandShortRagSeed((jdText ?? pseudoJDText) as string, input.experiences);
  const limit = experienceIds.length > 0 ? Math.max(experienceIds.length, 6) : 8;

  const outcome = await withTimeout(
    service.buildEvidencePack({
      userId: context.userId,
      jdText: requestedJDText,
      limit,
    }),
    RAG_TIMEOUT_MS,
  );

  if (!outcome.ok) {
    const detail = outcome.reason === "timeout"
      ? "evidence_rag_timeout"
      : ("evidence_rag_unavailable" + (outcome.detail ? ": " + outcome.detail : ""));
    return {
      diagnostics: {
        status: outcome.reason === "timeout" ? "timeout" : "unavailable",
        trigger,
        detail,
      },
    };
  }
  const pack = outcome.value;
  if (!pack || pack.allowedClaims.length === 0) {
    return { pack, diagnostics: { status: "ok_empty", trigger } };
  }
  if (trigger === "experience") {
    const allowed = new Set(experienceIds);
    const scopedPack: EvidencePack = {
      ...pack,
      allowedClaims: pack.allowedClaims.filter((claim) => allowed.has(claim.experienceId)),
    };
    return {
      pack: scopedPack,
      diagnostics: { status: scopedPack.allowedClaims.length === 0 ? "ok_empty" : "ok", trigger },
    };
  }
  return { pack, diagnostics: { status: "ok", trigger } };
}

function synthesizePseudoJDFromExperiences(experiences: ResolvedExperienceLite[]): string {
  const lines: string[] = [];
  for (const exp of experiences.slice(0, 3)) {
    lines.push("Role: " + (exp.role ?? exp.title));
    if (exp.organization) lines.push("Organization: " + exp.organization);
    if (exp.tags.length > 0) lines.push("Skills: " + exp.tags.join(", "));
    if (exp.content) lines.push(exp.content.slice(0, 600));
    lines.push("");
  }
  return lines.join("\n").trim();
}

function expandShortRagSeed(seed: string, experiences: ResolvedExperienceLite[]): string {
  if (seed.trim().length >= 40) return seed.trim();
  const lines = ["Writing target / retrieval seed: " + seed.trim()];
  for (const exp of experiences.slice(0, 2)) {
    lines.push("Candidate experience: " + exp.title);
    if (exp.role) lines.push("Role: " + exp.role);
    if (exp.tags.length > 0) lines.push("Skills: " + exp.tags.join(", "));
  }
  return lines.join("\n");
}

// -------------------- Guideline RAG --------------------

/**
 * Phase 4 - GuidelineRAG integration (style only).
 *
 * GuidelineRAG returns an InstructionPack containing writing rules, hard
 * constraints, and section strategies. We ONLY consume the style-shaping
 * fields (writingRules + softPreferences + sectionStrategy) and we hard-strip
 * any rule that smells like an unverified factual claim (numeric metrics,
 * named companies, date ranges). Stripped rules are counted in the
 * diagnostics so the writing tool can emit a riskNote pointing operators at
 * potentially mis-curated guideline content.
 *
 * Guideline rules NEVER provide facts - they only shape tone, structure, and
 * industry-specific phrasing.
 */
export async function buildGuidelineOutcome(
  context: AgentContext,
  input: {
    outputType: string;
    constraints: { tone?: string; audience?: string; format?: string; language?: "zh" | "en" | "auto"; length?: string };
    jdText?: string;
    pseudoSeed?: string;
    targetRole?: string;
  },
): Promise<{ pack?: InstructionPack; styleRules: string[]; diagnostics: GroundingDiagnostics["guidelineRag"] }> {
  const service = context.kernel.productServices.guidelineRAGService;
  if (!service) {
    return { styleRules: [], diagnostics: { status: "skipped_no_service", filteredFactBearingCount: 0 } };
  }
  const seedParts: string[] = [];
  if (input.jdText && input.jdText.trim().length >= 40) seedParts.push(input.jdText.trim());
  if (input.pseudoSeed && input.pseudoSeed.length >= 40) seedParts.push(input.pseudoSeed);
  if (input.constraints.tone) seedParts.push("Preferred tone: " + input.constraints.tone);
  if (input.constraints.audience) seedParts.push("Target audience: " + input.constraints.audience);
  if (input.constraints.format) seedParts.push("Required format: " + input.constraints.format);
  seedParts.push("Writing flavor: " + input.outputType);
  const seed = seedParts.join("\n").trim();
  if (seed.length < 40) {
    return { styleRules: [], diagnostics: { status: "skipped_no_signal", filteredFactBearingCount: 0 } };
  }

  const outcome = await withTimeout(
    service.buildInstructionPack({
      userId: context.userId,
      jdText: seed,
      targetRole: input.targetRole,
      limit: 8,
    }),
    RAG_TIMEOUT_MS,
  );

  if (!outcome.ok) {
    return {
      styleRules: [],
      diagnostics: {
        status: outcome.reason === "timeout" ? "timeout" : "unavailable",
        filteredFactBearingCount: 0,
        detail: outcome.reason === "timeout" ? "guideline_rag_timeout" : "guideline_rag_unavailable",
      },
    };
  }
  const pack = outcome.value;
  if (!pack) {
    return { styleRules: [], diagnostics: { status: "ok_empty", filteredFactBearingCount: 0 } };
  }
  const filtered = filterStyleOnlyRules(pack);
  return {
    pack,
    styleRules: filtered.rules,
    diagnostics: {
      status: filtered.rules.length === 0 ? "ok_empty" : "ok",
      filteredFactBearingCount: filtered.removedCount,
    },
  };
}

/**
 * Phase 4 - guideline safety filter.
 *
 * We accept rules from `writingRules` and `softPreferences`. Any rule whose
 * text contains:
 *   - a number (digit run >= 2 chars), OR
 *   - a quoted company / product name, OR
 *   - a percent sign, OR
 *   - a date / year token
 * is dropped from the prompt-side list. These rules are NOT removed from the
 * underlying `InstructionPack` (other product flows may still use them); the
 * filter only narrows what compose_career_text injects into its own prompt.
 */
function filterStyleOnlyRules(pack: InstructionPack): { rules: string[]; removedCount: number } {
  const SUSPICIOUS = /(\d{2,})|(\d+%)|(\b(19|20)\d{2}\b)|("[^"]{2,}")|(\u201c[^\u201d]{2,}\u201d)/u;
  const candidates = [
    ...(pack.writingRules ?? []),
    ...(pack.softPreferences ?? []),
  ].filter((rule, i, arr) => rule && arr.indexOf(rule) === i);
  const rules: string[] = [];
  let removed = 0;
  for (const rule of candidates) {
    if (SUSPICIOUS.test(rule)) {
      removed += 1;
      continue;
    }
    rules.push(rule);
    if (rules.length >= 8) break;
  }
  return { rules, removedCount: removed };
}
