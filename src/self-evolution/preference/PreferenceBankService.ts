import { randomUUID } from "node:crypto";
import type { LearningEvent } from "../../agent-core/reflection/LearningEvent.js";
import type { ProductGenerationRepository } from "../../product/repositories/index.js";
import type { ProductGeneratedVariant, ProductGeneration } from "../../product/types.js";
import type { EvidencePack } from "../../rag/evidence/types.js";
import type { InstructionPack } from "../../rag/guideline/types.js";
import { PreferenceConsolidator } from "./PreferenceConsolidator.js";
import type { PreferenceRepository } from "./PreferenceRepository.js";
import { PreferenceSignalExtractor } from "./PreferenceSignalExtractor.js";
import type {
  PersonalizationPack,
  PreferenceEventRecord,
  PreferenceInstruction,
  PreferenceScope,
  PreferenceStatus,
  PreferenceUpdateResult,
  UserPreference,
} from "./types.js";

export type PreferenceBankServiceDeps = {
  repository: PreferenceRepository;
  generationRepository?: Pick<ProductGenerationRepository, "getGeneration">;
  now?: () => Date;
};

export class PreferenceBankService {
  private readonly extractor = new PreferenceSignalExtractor();
  private readonly consolidator: PreferenceConsolidator;
  private readonly now: () => Date;

  public constructor(private readonly deps: PreferenceBankServiceDeps) {
    this.consolidator = new PreferenceConsolidator(deps.repository);
    this.now = deps.now ?? (() => new Date());
  }

  public async recordLearningEvent(event: LearningEvent): Promise<PreferenceUpdateResult> {
    const normalized = toPreferenceEvent(event);
    const saved = await this.deps.repository.saveEvent(normalized);
    if (!saved.inserted) {
      return { event: saved.event, inserted: false, signals: [], preferences: [] };
    }

    const enrichment = await this.resolveEnrichment(saved.event);
    const signals = this.extractor.extract(saved.event, enrichment);
    const preferences: UserPreference[] = [];
    for (const signal of signals) {
      preferences.push(await this.consolidator.apply(saved.event.userId, signal, saved.event.createdAt));
    }
    return { event: saved.event, inserted: true, signals, preferences };
  }

  public async recordExplicitPreference(input: {
    userId: string;
    instruction: string;
    scope?: PreferenceScope;
    polarity?: "positive" | "negative";
    sessionId?: string;
    turnId?: string;
    source?: string;
  }): Promise<PreferenceUpdateResult> {
    const now = this.now().toISOString();
    const event: LearningEvent = {
      id: `le-${randomUUID()}`,
      type: "user.preference_signal",
      userId: input.userId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      source: input.source ?? "preference_api",
      payload: {
        actionType: "explicit_instruction",
        preferenceText: input.instruction,
        preferencePolarity: input.polarity ?? "positive",
        ...(input.scope ?? {}),
      },
      createdAt: now,
    };
    return this.recordLearningEvent(event);
  }

  public async recordVariantDecision(input: {
    userId: string;
    generationId: string;
    variantId: string;
    action: "accepted" | "rejected";
    sessionId?: string;
    source?: string;
  }): Promise<PreferenceUpdateResult> {
    return this.recordLearningEvent({
      id: `le-${randomUUID()}`,
      type: input.action === "accepted" ? "variant.accepted" : "variant.rejected",
      userId: input.userId,
      sessionId: input.sessionId,
      source: input.source ?? "preference_bank",
      payload: {
        generationId: input.generationId,
        variantId: input.variantId,
      },
      createdAt: this.now().toISOString(),
    });
  }

  public listPreferences(
    userId: string,
    options: { statuses?: PreferenceStatus[]; limit?: number } = {},
  ): Promise<UserPreference[]> {
    return this.deps.repository.listPreferences(userId, options);
  }

  public async buildPersonalizationPack(input: {
    userId: string;
    context?: PreferenceScope;
    limit?: number;
  }): Promise<PersonalizationPack> {
    const context = compactScope(input.context ?? {});
    const stored = await this.deps.repository.listPreferences(input.userId, {
      statuses: ["active", "locked", "candidate", "stale"],
      limit: 500,
    });
    const now = this.now();
    const scored = stored
      .map((preference) => scorePreference(preference, context, now))
      .filter((item): item is ScoredPreference => Boolean(item))
      .sort((a, b) => b.score - a.score || b.preference.confidence - a.preference.confidence);

    const active = scored.filter((item) => item.preference.status === "active" || item.preference.status === "locked");
    const selected = active.slice(0, input.limit ?? 12);
    const stablePreferences: PreferenceInstruction[] = [];
    const contextualPreferences: PreferenceInstruction[] = [];
    const negativePreferences: PreferenceInstruction[] = [];
    const experienceAffinities: PersonalizationPack["experienceAffinities"] = [];

    for (const item of selected) {
      const preference = item.preference;
      const instruction = toInstruction(preference, item.effectiveStrength);
      if (preference.dimension === "experience_selection" && preference.experienceId) {
        experienceAffinities.push({
          preferenceId: preference.id,
          experienceId: preference.experienceId,
          affinity: Number(item.effectiveStrength.toFixed(4)),
          confidence: preference.confidence,
          reason: preference.instruction,
        });
        continue;
      }
      if (item.effectiveStrength < 0) {
        negativePreferences.push(instruction);
      } else if (isGlobalScope(preference.scope) || preference.status === "locked") {
        stablePreferences.push(instruction);
      } else {
        contextualPreferences.push(instruction);
      }
    }

    const uncertainPreferences = scored
      .filter((item) => item.preference.status === "candidate" && Math.abs(item.effectiveStrength) >= 0.12)
      .slice(0, 6)
      .map((item) => toInstruction(item.preference, item.effectiveStrength));
    const staleCount = stored.filter((item) => item.status === "stale").length;
    const appliedIds = selected.map((item) => item.preference.id);
    if (appliedIds.length > 0) {
      await this.deps.repository.touchPreferences(input.userId, appliedIds, now.toISOString());
    }

    return {
      version: "preference-bank-v1",
      context,
      stablePreferences,
      contextualPreferences,
      negativePreferences,
      experienceAffinities,
      uncertainPreferences,
      retrievalTrace: selected.map((item) => ({
        preferenceId: item.preference.id,
        dimension: item.preference.dimension,
        score: Number(item.score.toFixed(4)),
        effectiveStrength: Number(item.effectiveStrength.toFixed(4)),
        scopeMatch: Number(item.scopeMatch.toFixed(4)),
        sourceEventIds: [...item.preference.evidenceEventIds],
      })),
      diagnostics: {
        totalStored: stored.length,
        activeCandidates: active.length,
        appliedCount: selected.length,
        staleCount,
        warnings: selected.length === 0
          ? ["No stable user preferences matched the current context yet."]
          : [],
      },
    };
  }

  public applyToInstructionPack(
    instructionPack: InstructionPack | undefined,
    personalizationPack: PersonalizationPack,
  ): InstructionPack | undefined {
    if (!instructionPack) return undefined;
    const preferences = [
      ...personalizationPack.stablePreferences,
      ...personalizationPack.contextualPreferences,
    ].map((item) => item.instruction);
    const avoids = personalizationPack.negativePreferences.map(
      (item) => `User preference to avoid or downweight: ${item.instruction}`,
    );
    return {
      ...instructionPack,
      softPreferences: unique([
        ...(instructionPack.softPreferences ?? []),
        ...preferences,
        ...avoids,
      ]),
    };
  }

  public applyToEvidencePack(
    evidencePack: EvidencePack | undefined,
    personalizationPack: PersonalizationPack,
  ): EvidencePack | undefined {
    if (!evidencePack || personalizationPack.experienceAffinities.length === 0) return evidencePack;
    const affinity = new Map(
      personalizationPack.experienceAffinities.map((item) => [item.experienceId, item.affinity]),
    );
    const retrievalTrace = [...evidencePack.retrievalTrace].sort((a, b) => {
      const aScore = a.score + (affinity.get(a.experienceId) ?? 0) * 0.08;
      const bScore = b.score + (affinity.get(b.experienceId) ?? 0) * 0.08;
      return bScore - aScore;
    });
    const allowedClaims = [...evidencePack.allowedClaims].sort((a, b) => {
      const riskDelta = riskRank(a.riskLevel) - riskRank(b.riskLevel);
      if (riskDelta !== 0) return riskDelta;
      const aScore = a.confidence + (affinity.get(a.experienceId) ?? 0) * 0.05;
      const bScore = b.confidence + (affinity.get(b.experienceId) ?? 0) * 0.05;
      return bScore - aScore;
    });
    const diagnostics = evidencePack.diagnostics;
    return {
      ...evidencePack,
      retrievalTrace,
      allowedClaims,
      ...(diagnostics ? {
        diagnostics: {
          ...diagnostics,
          warnings: unique([
            ...diagnostics.warnings,
            "PreferenceBank applied bounded experience-affinity reranking without changing the factual evidence boundary.",
          ]),
        },
      } : {}),
    };
  }

  private async resolveEnrichment(event: PreferenceEventRecord): Promise<{
    scope?: PreferenceScope;
    variant?: ProductGeneratedVariant;
  }> {
    const generationId = stringValue(event.payload.generationId);
    if (!generationId || !this.deps.generationRepository) {
      return { scope: scopeFromPayload(event.payload) };
    }
    const generation = await this.deps.generationRepository.getGeneration(event.userId, generationId);
    if (!generation) return { scope: scopeFromPayload(event.payload) };
    const variantId = stringValue(event.payload.variantId);
    const variant = variantId
      ? generation.outputSnapshot?.variants?.find((item) => item.id === variantId)
      : undefined;
    return {
      scope: {
        ...scopeFromGeneration(generation),
        ...scopeFromPayload(event.payload),
      },
      variant,
    };
  }
}

type ScoredPreference = {
  preference: UserPreference;
  score: number;
  scopeMatch: number;
  effectiveStrength: number;
};

function scorePreference(
  preference: UserPreference,
  context: PreferenceScope,
  now: Date,
): ScoredPreference | undefined {
  const scopeMatch = calculateScopeMatch(preference.scope, context);
  if (scopeMatch <= 0) return undefined;
  const effectiveStrength = applyDecay(preference, now);
  const recency = recencyScore(preference.lastObservedAt, now);
  const score = (
    scopeMatch * 0.38
    + Math.abs(effectiveStrength) * 0.27
    + preference.confidence * 0.25
    + recency * 0.1
  );
  return { preference, score, scopeMatch, effectiveStrength };
}

function calculateScopeMatch(scope: PreferenceScope, context: PreferenceScope): number {
  const keys: Array<keyof PreferenceScope> = [
    "roleFamily",
    "applicationType",
    "language",
    "section",
    "industry",
    "targetRole",
  ];
  let matched = 0;
  let specified = 0;
  for (const key of keys) {
    const expected = normalizeScopeValue(scope[key]);
    if (!expected) continue;
    specified += 1;
    const actual = normalizeScopeValue(context[key]);
    if (!actual) {
      matched += 0.55;
      continue;
    }
    if (key === "targetRole") {
      if (actual.includes(expected) || expected.includes(actual)) matched += 1;
      else matched += 0.2;
      continue;
    }
    if (actual !== expected) return 0;
    matched += 1;
  }
  if (specified === 0) return 0.72;
  return matched / specified;
}

function applyDecay(preference: UserPreference, now: Date): number {
  if (preference.status === "locked" || preference.metadata.explicit === true) return preference.strength;
  const last = Date.parse(preference.lastObservedAt);
  if (!Number.isFinite(last)) return preference.strength;
  const days = Math.max(0, (now.getTime() - last) / 86_400_000);
  const halfLife = preference.status === "candidate" ? 45 : 180;
  const factor = Math.pow(0.5, days / halfLife);
  return preference.strength * factor;
}

function recencyScore(value: string, now: Date): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 0;
  const days = Math.max(0, (now.getTime() - timestamp) / 86_400_000);
  return Math.exp(-days / 120);
}

function toInstruction(preference: UserPreference, effectiveStrength: number): PreferenceInstruction {
  return {
    preferenceId: preference.id,
    dimension: preference.dimension,
    instruction: preference.instruction,
    strength: Number(effectiveStrength.toFixed(4)),
    confidence: preference.confidence,
    scope: { ...preference.scope },
  };
}

function scopeFromGeneration(generation: ProductGeneration): PreferenceScope {
  const instructionPack = isRecord(generation.inputSnapshot.instructionPack)
    ? generation.inputSnapshot.instructionPack
    : undefined;
  const personalizationPack = isRecord(generation.inputSnapshot.personalizationPack)
    ? generation.inputSnapshot.personalizationPack
    : undefined;
  const context = personalizationPack && isRecord(personalizationPack.context)
    ? personalizationPack.context
    : undefined;
  const language = stringValue(instructionPack?.language ?? context?.language);
  return compactScope({
    roleFamily: stringValue(instructionPack?.roleFamily ?? context?.roleFamily),
    applicationType: stringValue(instructionPack?.applicationType ?? context?.applicationType),
    language: language === "zh" || language === "en" ? language : undefined,
    targetRole: generation.targetRole ?? stringValue(generation.inputSnapshot.targetRole),
    industry: stringValue(instructionPack?.industry ?? context?.industry),
  });
}

function scopeFromPayload(payload: Record<string, unknown>): PreferenceScope {
  const language = stringValue(payload.language);
  return compactScope({
    roleFamily: stringValue(payload.roleFamily),
    applicationType: stringValue(payload.applicationType),
    language: language === "zh" || language === "en" ? language : undefined,
    section: stringValue(payload.section),
    targetRole: stringValue(payload.targetRole),
    industry: stringValue(payload.industry),
  });
}

function compactScope(scope: PreferenceScope): PreferenceScope {
  return Object.fromEntries(
    Object.entries(scope).filter(([, value]) => typeof value === "string" && value.trim().length > 0),
  ) as PreferenceScope;
}

function isGlobalScope(scope: PreferenceScope): boolean {
  return Object.keys(compactScope(scope)).length === 0;
}

function normalizeScopeValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
    : undefined;
}

function toPreferenceEvent(event: LearningEvent): PreferenceEventRecord {
  const payload = isRecord(event.payload) ? event.payload : {};
  return {
    id: event.id,
    dedupeKey: dedupeKeyFor(event.type, payload),
    userId: event.userId,
    type: event.type,
    sessionId: event.sessionId,
    turnId: event.turnId,
    source: event.source,
    payload,
    createdAt: event.createdAt,
  };
}

function dedupeKeyFor(type: string, payload: Record<string, unknown>): string | undefined {
  const generationId = stringValue(payload.generationId);
  const variantId = stringValue(payload.variantId);
  if ((type === "variant.accepted" || type === "variant.rejected") && generationId && variantId) {
    return `${type}:${generationId}:${variantId}`;
  }
  // Repeated preference statements are meaningful reinforcement, not duplicate delivery.
  // Event ids already protect a single LearningEvent from being stored twice.
  return undefined;
}

function riskRank(value: EvidencePack["allowedClaims"][number]["riskLevel"]): number {
  if (value === "high") return 2;
  if (value === "medium") return 1;
  return 0;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
