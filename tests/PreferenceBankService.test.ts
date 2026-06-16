import { describe, expect, it } from "vitest";
import type { ProductGenerationRepository } from "../src/product/repositories/index.js";
import type { ProductGeneration } from "../src/product/types.js";
import {
  InMemoryPreferenceRepository,
  PreferenceBankService,
  PreferenceContextProvider,
  PreferenceReflectionSink,
} from "../src/self-evolution/preference/index.js";
import type { LearningEvent } from "../src/agent-core/reflection/LearningEvent.js";

describe("PreferenceBankService", () => {
  it("turns an explicit scoped preference into an active contextual instruction", async () => {
    const repository = new InMemoryPreferenceRepository();
    const service = new PreferenceBankService({
      repository,
      now: () => new Date("2026-06-16T10:00:00.000Z"),
    });

    const update = await service.recordExplicitPreference({
      userId: "user-1",
      instruction: "更简洁，减少背景描述，直接写技术行动。",
      scope: { roleFamily: "ai_ml", language: "zh" },
    });

    expect(update.inserted).toBe(true);
    expect(update.preferences.some((item) => item.status === "active")).toBe(true);

    const matching = await service.buildPersonalizationPack({
      userId: "user-1",
      context: { roleFamily: "ai_ml", language: "zh" },
    });
    expect(matching.contextualPreferences.some((item) => item.dimension === "verbosity")).toBe(true);

    const mismatched = await service.buildPersonalizationPack({
      userId: "user-1",
      context: { roleFamily: "software", language: "zh" },
    });
    expect(mismatched.contextualPreferences).toHaveLength(0);
  });

  it("learns experience affinity from an accepted variant and deduplicates repeated event delivery", async () => {
    const generations = new Map<string, ProductGeneration>();
    generations.set("pgen-1", generation("pgen-1", "pvar-1", ["pexp-a"]));
    const repository = new InMemoryPreferenceRepository();
    const service = new PreferenceBankService({
      repository,
      generationRepository: generationRepository(generations),
      now: () => new Date("2026-06-16T10:00:00.000Z"),
    });

    const first = await service.recordVariantDecision({
      userId: "user-1",
      generationId: "pgen-1",
      variantId: "pvar-1",
      action: "accepted",
    });
    expect(first.inserted).toBe(true);

    const duplicateEvent: LearningEvent = {
      id: "le-duplicate-delivery",
      type: "variant.accepted",
      userId: "user-1",
      source: "plan_execution_service",
      payload: { generationId: "pgen-1", variantId: "pvar-1" },
      createdAt: "2026-06-16T10:01:00.000Z",
    };
    const duplicate = await service.recordLearningEvent(duplicateEvent);
    expect(duplicate.inserted).toBe(false);

    const pack = await service.buildPersonalizationPack({
      userId: "user-1",
      context: { roleFamily: "ai_ml", applicationType: "internship", language: "en" },
    });
    expect(pack.experienceAffinities).toEqual(expect.arrayContaining([
      expect.objectContaining({ experienceId: "pexp-a" }),
    ]));
  });

  it("requires repeated implicit style evidence before activating it", async () => {
    const generations = new Map<string, ProductGeneration>();
    generations.set("pgen-1", generation("pgen-1", "pvar-1", ["pexp-a"]));
    generations.set("pgen-2", generation("pgen-2", "pvar-2", ["pexp-b"]));
    const repository = new InMemoryPreferenceRepository();
    const service = new PreferenceBankService({
      repository,
      generationRepository: generationRepository(generations),
      now: () => new Date("2026-06-16T10:00:00.000Z"),
    });

    await service.recordVariantDecision({
      userId: "user-1",
      generationId: "pgen-1",
      variantId: "pvar-1",
      action: "accepted",
    });
    const afterOne = await service.buildPersonalizationPack({
      userId: "user-1",
      context: { roleFamily: "ai_ml", applicationType: "internship", language: "en" },
    });
    expect(afterOne.contextualPreferences.some((item) => item.dimension === "verbosity")).toBe(false);

    await service.recordVariantDecision({
      userId: "user-1",
      generationId: "pgen-2",
      variantId: "pvar-2",
      action: "accepted",
    });
    const afterTwo = await service.buildPersonalizationPack({
      userId: "user-1",
      context: { roleFamily: "ai_ml", applicationType: "internship", language: "en" },
    });
    expect(afterTwo.contextualPreferences.some((item) => item.dimension === "verbosity")).toBe(true);
  });

  it("treats repeated explicit preference statements as reinforcement rather than duplicate delivery", async () => {
    const repository = new InMemoryPreferenceRepository();
    const service = new PreferenceBankService({
      repository,
      now: () => new Date("2026-06-16T10:00:00.000Z"),
    });

    const first = await service.recordExplicitPreference({
      userId: "user-1",
      instruction: "I prefer concise bullets.",
      scope: { roleFamily: "ai_ml", language: "en" },
    });
    const second = await service.recordExplicitPreference({
      userId: "user-1",
      instruction: "I prefer concise bullets.",
      scope: { roleFamily: "ai_ml", language: "en" },
    });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(true);
    const preferences = await service.listPreferences("user-1");
    const concise = preferences.find((item) => item.dimension === "verbosity" && item.value === "concise");
    expect(concise).toMatchObject({ supportCount: 2, status: "active" });
  });

  it("learns style immediately when the user explicitly prefers a generated variant", async () => {
    const generations = new Map<string, ProductGeneration>();
    generations.set("pgen-1", generation("pgen-1", "pvar-1", ["pexp-a"]));
    const repository = new InMemoryPreferenceRepository();
    const service = new PreferenceBankService({
      repository,
      generationRepository: generationRepository(generations),
      now: () => new Date("2026-06-16T10:00:00.000Z"),
    });

    const update = await service.recordLearningEvent({
      id: "le-prefer-variant",
      type: "user.preference_signal",
      userId: "user-1",
      source: "explicit_action",
      payload: {
        actionType: "prefer",
        generationId: "pgen-1",
        variantId: "pvar-1",
      },
      createdAt: "2026-06-16T10:00:00.000Z",
    });

    expect(update.preferences.some((item) => item.dimension === "verbosity" && item.status === "active")).toBe(true);
    expect(update.preferences.some((item) => item.dimension === "experience_selection")).toBe(false);

    const pack = await service.buildPersonalizationPack({
      userId: "user-1",
      context: { roleFamily: "ai_ml", applicationType: "internship", language: "en" },
    });
    expect(pack.contextualPreferences.map((item) => item.dimension)).toContain("verbosity");
    expect(pack.experienceAffinities).toHaveLength(0);
  });

  it("uses the Phase 10 reflection sink and context provider as real capability adapters", async () => {
    const repository = new InMemoryPreferenceRepository();
    const service = new PreferenceBankService({ repository });
    const sink = new PreferenceReflectionSink(service);
    await sink.record({
      id: "le-free-text",
      type: "user.preference_signal",
      userId: "user-1",
      source: "user_message",
      payload: {
        actionType: "free_text_preference",
        preferenceText: "Please make the resume more conservative and concise.",
        targetRole: "AI Engineer Intern",
        roleFamily: "ai_ml",
        applicationType: "internship",
        language: "en",
      },
      createdAt: "2026-06-16T10:00:00.000Z",
    });

    const provider = new PreferenceContextProvider(service);
    const output = await provider.provide({
      userId: "user-1",
      sessionId: "session-1",
      turnId: "turn-1",
      userMessage: "Generate my resume for this AI role.",
      productContext: {
        targetRole: "AI Engineer Intern",
        roleFamily: "ai_ml",
        applicationType: "internship",
        language: "en",
      },
    } as never);

    const pack = output.preferenceBank as { contextualPreferences: Array<{ dimension: string }> };
    expect(pack.contextualPreferences.map((item) => item.dimension)).toEqual(
      expect.arrayContaining(["packaging_strength", "verbosity"]),
    );
  });
});

function generation(
  id: string,
  variantId: string,
  sourceExperienceIds: string[],
): ProductGeneration {
  return {
    id,
    userId: "user-1",
    targetRole: "AI Engineer Intern",
    inputSnapshot: {
      instructionPack: {
        roleFamily: "ai_ml",
        applicationType: "internship",
        language: "en",
      },
    },
    outputSnapshot: {
      variants: [{
        id: variantId,
        userId: "user-1",
        content: "Built an LLM RAG evaluation pipeline in Python and PyTorch, improving verified task accuracy by 12%.",
        sourceExperienceIds,
        sourceEvidenceIds: ["claim-1"],
        createdAt: "2026-06-16T09:00:00.000Z",
        variantName: "Technical concise version",
        scenario: "AI research",
      }],
    },
    selectedVariantIds: [],
    createdAt: "2026-06-16T09:00:00.000Z",
  };
}

function generationRepository(
  generations: Map<string, ProductGeneration>,
): Pick<ProductGenerationRepository, "getGeneration"> {
  return {
    getGeneration: async (userId, id) => {
      const item = generations.get(id);
      return item?.userId === userId ? item : null;
    },
  };
}
