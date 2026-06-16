import type { AgentCapabilityModule } from "../../agent-core/capabilities/AgentCapabilityModule.js";
import type { ContextProvider } from "../../agent-core/context/ContextProvider.js";
import type { AgentContext } from "../../agent-core/runtime/AgentContext.js";
import type { MemoryProvider, MemoryRetrieveInput } from "../../agent-core/memory/MemoryProvider.js";
import type { MemoryRecord } from "../../agent-core/memory/MemoryRecord.js";
import type { ReflectionSink } from "../../agent-core/reflection/ReflectionSink.js";
import type { LearningEvent } from "../../agent-core/reflection/LearningEvent.js";
import type { RetrievalProvider } from "../../agent-core/retrieval/RetrievalProvider.js";
import type { RetrievalQuery } from "../../agent-core/retrieval/RetrievalQuery.js";
import type { RetrievalResult } from "../../agent-core/retrieval/RetrievalResult.js";
import type { RetrievalScope } from "../../agent-core/retrieval/RetrievalScope.js";
import type { PreferenceBankService } from "./PreferenceBankService.js";
import type { PreferenceScope } from "./types.js";

export class PreferenceReflectionSink implements ReflectionSink {
  public readonly id = "preference-bank.reflection";
  public constructor(private readonly service: PreferenceBankService) {}
  public async record(event: LearningEvent): Promise<void> {
    await this.service.recordLearningEvent(event);
  }
}

export class PreferenceMemoryProvider implements MemoryProvider {
  public readonly id = "preference-bank.memory";
  public constructor(private readonly service: PreferenceBankService) {}

  public async retrieve(input: MemoryRetrieveInput): Promise<MemoryRecord[]> {
    const pack = await this.service.buildPersonalizationPack({
      userId: input.userId,
      context: {},
      limit: input.limit ?? 10,
    });
    return [
      ...pack.stablePreferences,
      ...pack.contextualPreferences,
      ...pack.negativePreferences,
    ].map((item) => ({
      id: item.preferenceId,
      userId: input.userId,
      type: "preference" as const,
      text: item.instruction,
      weight: Math.abs(item.strength) * item.confidence,
      source: "preference-bank-v1",
      metadata: {
        dimension: item.dimension,
        scope: item.scope,
        query: input.query,
      },
    }));
  }
}

export class PreferenceRetrievalProvider implements RetrievalProvider {
  public readonly id = "preference-bank.retrieval";
  public constructor(private readonly service: PreferenceBankService) {}

  public supports(scope: RetrievalScope): boolean {
    return scope === "strategy_memory";
  }

  public async retrieve(query: RetrievalQuery): Promise<RetrievalResult[]> {
    if (!query.scopes.includes("strategy_memory")) return [];
    const context = scopeFromConstraints(query.constraints);
    const pack = await this.service.buildPersonalizationPack({
      userId: query.userId,
      context,
      limit: query.limit ?? 10,
    });
    return [
      ...pack.stablePreferences,
      ...pack.contextualPreferences,
      ...pack.negativePreferences,
    ].map((item) => ({
      id: `preference-result-${item.preferenceId}`,
      scope: "strategy_memory" as const,
      sourceId: item.preferenceId,
      title: item.dimension,
      text: item.instruction,
      score: Math.abs(item.strength) * item.confidence,
      metadata: {
        preferenceScope: item.scope,
        query: query.query,
      },
    }));
  }
}

export class PreferenceContextProvider implements ContextProvider {
  public readonly id = "preference-bank.context";
  public constructor(private readonly service: PreferenceBankService) {}

  public async provide(context: AgentContext): Promise<Record<string, unknown>> {
    const scope = scopeFromAgentContext(context);
    const pack = await this.service.buildPersonalizationPack({
      userId: context.userId,
      context: scope,
      limit: 8,
    });
    return { preferenceBank: pack };
  }
}

export function createPreferenceCapabilityModule(service: PreferenceBankService): AgentCapabilityModule {
  return {
    id: "preference-bank.v1",
    contextProviders: [new PreferenceContextProvider(service)],
    retrievalProviders: [new PreferenceRetrievalProvider(service)],
    memoryProviders: [new PreferenceMemoryProvider(service)],
    reflectionSinks: [new PreferenceReflectionSink(service)],
  };
}

function scopeFromAgentContext(context: AgentContext): PreferenceScope {
  const product = context.productContext ?? {};
  const language = stringValue(product.language) ?? detectLanguage(context.userMessage);
  return compactScope({
    targetRole: stringValue(product.targetRole),
    roleFamily: stringValue(product.roleFamily),
    applicationType: stringValue(product.applicationType),
    language: language === "zh" || language === "en" ? language : undefined,
    section: stringValue(product.section),
    industry: stringValue(product.industry),
  });
}

function scopeFromConstraints(value: Record<string, unknown> | undefined): PreferenceScope {
  if (!value) return {};
  const language = stringValue(value.language);
  return compactScope({
    targetRole: stringValue(value.targetRole),
    roleFamily: stringValue(value.roleFamily),
    applicationType: stringValue(value.applicationType),
    language: language === "zh" || language === "en" ? language : undefined,
    section: stringValue(value.section),
    industry: stringValue(value.industry),
  });
}

function detectLanguage(value: unknown): "zh" | "en" {
  const text = typeof value === "string" ? value : "";
  const chinese = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  return chinese >= 2 ? "zh" : "en";
}

function compactScope(scope: PreferenceScope): PreferenceScope {
  return Object.fromEntries(
    Object.entries(scope).filter(([, value]) => typeof value === "string" && value.trim().length > 0),
  ) as PreferenceScope;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
