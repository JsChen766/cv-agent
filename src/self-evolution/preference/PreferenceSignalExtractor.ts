import { randomUUID } from "node:crypto";
import type { ProductGeneratedVariant } from "../../product/types.js";
import type {
  PreferenceEventRecord,
  PreferenceScope,
  PreferenceSignal,
} from "./types.js";

export type PreferenceSignalEnrichment = {
  scope?: PreferenceScope;
  variant?: ProductGeneratedVariant;
};

export class PreferenceSignalExtractor {
  public extract(
    event: PreferenceEventRecord,
    enrichment: PreferenceSignalEnrichment = {},
  ): PreferenceSignal[] {
    const scope = compactScope({
      ...scopeFromPayload(event.payload),
      ...(enrichment.scope ?? {}),
    });

    if (event.type === "user.preference_signal") {
      const explicitSignals = this.extractExplicitSignals(event, scope);
      const actionType = stringValue(event.payload.actionType);
      if (actionType !== "prefer" || !enrichment.variant) return explicitSignals;

      const preferredStyleSignals = this.extractVariantSignals(
        event,
        enrichment.variant,
        scope,
        1,
      )
        .filter((signal) => signal.dimension !== "experience_selection")
        .map((signal) => ({
          ...signal,
          explicit: true,
          confidence: Math.max(signal.confidence, 0.84),
          metadata: {
            ...signal.metadata,
            preferenceSource: "preferred_variant_style",
          },
        }));
      return dedupeSignals([...explicitSignals, ...preferredStyleSignals]);
    }

    if (event.type === "variant.accepted" || event.type === "variant.rejected") {
      const variant = enrichment.variant;
      if (!variant) return [];
      return this.extractVariantSignals(
        event,
        variant,
        scope,
        event.type === "variant.accepted" ? 1 : -1,
      );
    }

    if (event.type === "variant.revised") {
      return this.extractRevisionSignals(event, scope);
    }

    return [];
  }

  private extractExplicitSignals(
    event: PreferenceEventRecord,
    scope: PreferenceScope,
  ): PreferenceSignal[] {
    const actionType = stringValue(event.payload.actionType);
    if (actionType === "accept") return [];

    const explicitText = stringValue(event.payload.preferenceText)
      ?? stringValue(event.payload.instruction)
      ?? stringValue(event.payload.userMessage);
    const requestedPolarity: 1 | -1 = event.payload.preferencePolarity === "negative" ? -1 : 1;
    const text = [explicitText, actionType].filter(Boolean).join(" ");
    const normalized = text.toLowerCase();
    const signals: PreferenceSignal[] = [];

    const add = (
      dimension: PreferenceSignal["dimension"],
      value: string,
      instruction: string,
      polarity: 1 | -1 = 1,
      confidence = 0.95,
    ) => {
      signals.push(this.signal(event, {
        dimension,
        value,
        instruction,
        polarity,
        confidence,
        explicit: true,
        scope,
      }));
    };

    if (actionType === "revise_more_conservative" || matchesAny(normalized, [
      /更保守/, /不要夸张/, /别夸张/, /不要过度包装/, /弱化(?:领导|负责|主导)/,
      /more conservative/, /less promotional/, /do not overstate/, /avoid exaggerat/,
    ])) {
      add(
        "packaging_strength",
        "conservative_attribution",
        "Use conservative responsibility attribution and do not overstate ownership or leadership.",
      );
      add(
        "evidence_risk",
        "strict_grounding",
        "Keep every factual claim within verified evidence and surface uncertainty instead of filling gaps.",
      );
    }

    if (actionType === "revise_more_quantified" || matchesAny(normalized, [
      /更量化/, /多用数据/, /突出指标/, /quantif/, /more metrics?/, /data[- ]driven/,
    ])) {
      add(
        "metric_usage",
        "verified_quantification",
        "Prefer quantified impact when the metric is verified; otherwise omit the number or ask for confirmation.",
      );
    }

    if (actionType === "confirm_metric") {
      add(
        "metric_usage",
        "verified_quantification",
        "Use confirmed metrics prominently and preserve their exact scope and units.",
      );
    }

    if (matchesAny(normalized, [/不要量化/, /少用数据/, /avoid metrics?/, /no numbers?/])) {
      add(
        "metric_usage",
        "verified_quantification",
        "Prefer quantified impact when the metric is verified; otherwise omit the number or ask for confirmation.",
        -1,
      );
    }

    if (matchesAny(normalized, [
      /更简洁/, /精简/, /简短/, /少写背景/, /直接一点/, /concise/, /shorter/, /less verbose/,
    ])) {
      add(
        "verbosity",
        "concise",
        "Prefer concise bullets that lead with the action and remove non-essential background.",
      );
    }

    if (matchesAny(normalized, [/更详细/, /展开一点/, /保留细节/, /more detail/, /more comprehensive/])) {
      add(
        "verbosity",
        "detailed",
        "Preserve enough context, method, and result detail to make the contribution understandable.",
      );
    }

    if (matchesAny(normalized, [
      /技术细节/, /突出技术/, /方法细节/, /算法细节/, /technical detail/, /method detail/,
    ])) {
      add(
        "technical_depth",
        "high",
        "Preserve concrete methods, systems, tools, and evaluation details for technical roles.",
      );
    }

    if (matchesAny(normalized, [/不要太技术/, /弱化技术/, /less technical/, /reduce technical detail/])) {
      add(
        "technical_depth",
        "high",
        "Preserve concrete methods, systems, tools, and evaluation details for technical roles.",
        -1,
      );
    }

    if (matchesAny(normalized, [/非营销/, /不要营销/, /不要浮夸/, /non[- ]promotional/, /plain language/])) {
      add(
        "writing_style",
        "non_promotional",
        "Use direct, professional, non-promotional language.",
      );
    }

    if (matchesAny(normalized, [/研究贡献/, /突出论文/, /方法和实验/, /research contribution/, /methods? and evaluation/])) {
      add(
        "role_focus",
        "research_method",
        "Prioritize research contribution, methodology, and evaluation evidence when relevant.",
      );
    }

    if (matchesAny(normalized, [/业务影响/, /产品影响/, /商业价值/, /business impact/, /product impact/])) {
      add(
        "role_focus",
        "business_impact",
        "Prioritize supported product or business impact over generic task descriptions.",
      );
    }

    if (matchesAny(normalized, [/不要虚构/, /不能编造/, /事实边界/, /no fabrication/, /do not invent/])) {
      add(
        "evidence_risk",
        "strict_grounding",
        "Keep every factual claim within verified evidence and surface uncertainty instead of filling gaps.",
      );
    }

    if (signals.length === 0 && explicitText) {
      add(
        "writing_style",
        `custom:${normalizePreferenceValue(explicitText).slice(0, 80)}`,
        explicitText,
        requestedPolarity,
        0.98,
      );
    } else if (requestedPolarity < 0) {
      for (const signal of signals) signal.polarity = -1;
    }

    return dedupeSignals(signals);
  }

  private extractVariantSignals(
    event: PreferenceEventRecord,
    variant: ProductGeneratedVariant,
    scope: PreferenceScope,
    polarity: 1 | -1,
  ): PreferenceSignal[] {
    const content = variant.content.trim();
    const normalized = content.toLowerCase();
    const signals: PreferenceSignal[] = [];
    const confidence = polarity === 1 ? 0.68 : 0.5;

    const add = (
      dimension: PreferenceSignal["dimension"],
      value: string,
      instruction: string,
      signalConfidence = confidence,
      experienceId?: string,
    ) => {
      signals.push(this.signal(event, {
        dimension,
        value,
        instruction,
        polarity,
        confidence: signalConfidence,
        explicit: false,
        scope,
        experienceId,
      }));
    };

    if (content.length <= 420) {
      add(
        "verbosity",
        "concise",
        "Prefer concise bullets that lead with the action and remove non-essential background.",
      );
    } else if (content.length >= 900) {
      add(
        "verbosity",
        "detailed",
        "Preserve enough context, method, and result detail to make the contribution understandable.",
      );
    }

    if (/\b\d+(?:\.\d+)?\s*(?:%|x|ms|s|k|m|million|billion|倍|人|次|万)\b/i.test(content)) {
      add(
        "metric_usage",
        "verified_quantification",
        "Prefer quantified impact when the metric is verified; otherwise omit the number or ask for confirmation.",
      );
    }

    const technicalHits = [
      "model", "algorithm", "framework", "pipeline", "system", "architecture", "evaluation",
      "dataset", "api", "database", "deployment", "pytorch", "tensorflow", "llm", "rag",
      "模型", "算法", "系统", "架构", "评估", "数据集", "部署",
    ].filter((term) => normalized.includes(term)).length;
    if (technicalHits >= 3) {
      add(
        "technical_depth",
        "high",
        "Preserve concrete methods, systems, tools, and evaluation details for technical roles.",
      );
    }

    const descriptor = [variant.variantName, variant.summary, variant.scenario, ...(variant.advantages ?? [])]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (/research|method|论文|研究|算法/.test(descriptor)) {
      add(
        "role_focus",
        "research_method",
        "Prioritize research contribution, methodology, and evaluation evidence when relevant.",
      );
    }
    if (/business|product|impact|业务|产品/.test(descriptor)) {
      add(
        "role_focus",
        "business_impact",
        "Prioritize supported product or business impact over generic task descriptions.",
      );
    }
    if (/conservative|稳健|保守/.test(descriptor)) {
      add(
        "packaging_strength",
        "conservative_attribution",
        "Use conservative responsibility attribution and do not overstate ownership or leadership.",
      );
    }

    for (const experienceId of variant.sourceExperienceIds ?? []) {
      add(
        "experience_selection",
        experienceId,
        `Prefer experience ${experienceId} when it is relevant to the current target role.`,
        polarity === 1 ? 0.72 : 0.48,
        experienceId,
      );
    }

    return dedupeSignals(signals);
  }

  private extractRevisionSignals(
    event: PreferenceEventRecord,
    scope: PreferenceScope,
  ): PreferenceSignal[] {
    const beforeText = stringValue(event.payload.beforeText) ?? "";
    const afterText = stringValue(event.payload.afterText) ?? "";
    if (!beforeText || !afterText) return [];
    const signals: PreferenceSignal[] = [];
    if (afterText.length < beforeText.length * 0.78) {
      signals.push(this.signal(event, {
        dimension: "verbosity",
        value: "concise",
        instruction: "Prefer concise bullets that lead with the action and remove non-essential background.",
        polarity: 1,
        confidence: 0.86,
        explicit: false,
        scope,
      }));
    }
    if (countMetrics(afterText) > countMetrics(beforeText)) {
      signals.push(this.signal(event, {
        dimension: "metric_usage",
        value: "verified_quantification",
        instruction: "Prefer quantified impact when the metric is verified; otherwise omit the number or ask for confirmation.",
        polarity: 1,
        confidence: 0.84,
        explicit: false,
        scope,
      }));
    }
    return signals;
  }

  private signal(
    event: PreferenceEventRecord,
    input: Omit<PreferenceSignal, "id" | "eventId" | "metadata"> & {
      metadata?: Record<string, unknown>;
    },
  ): PreferenceSignal {
    return {
      id: `psig-${randomUUID()}`,
      eventId: event.id,
      metadata: {
        eventType: event.type,
        eventSource: event.source,
        ...(input.metadata ?? {}),
      },
      ...input,
    };
  }
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

function normalizePreferenceValue(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function countMetrics(value: string): number {
  return (value.match(/\b\d+(?:\.\d+)?\s*(?:%|x|ms|s|k|m|倍|人|次|万)\b/gi) ?? []).length;
}

function dedupeSignals(signals: PreferenceSignal[]): PreferenceSignal[] {
  const map = new Map<string, PreferenceSignal>();
  for (const signal of signals) {
    const key = `${signal.dimension}:${signal.value}:${signal.polarity}:${signal.experienceId ?? ""}`;
    const existing = map.get(key);
    if (!existing || signal.confidence > existing.confidence) map.set(key, signal);
  }
  return [...map.values()];
}

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
