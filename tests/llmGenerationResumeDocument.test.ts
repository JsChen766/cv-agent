import { describe, expect, it } from "vitest";
import { LLMGenerationService } from "../src/product/LLMGenerationService.js";
import { ModelClient } from "../src/agent-core/model/ModelClient.js";
import type { LLMChatRequest, LLMChatResponse, LLMProvider } from "../src/agent-core/model/types.js";
import type { ProductExperienceSummary } from "../src/product/types.js";

function fakeModelClient(rawContent: unknown): ModelClient {
  return new ModelClient({
    provider: {
      name: "test-provider",
      chat: async (_request: LLMChatRequest): Promise<LLMChatResponse> => ({
        content: JSON.stringify(rawContent),
      }),
    } satisfies LLMProvider,
    defaultModel: "test-model",
    maxRetries: 0,
  });
}

function fakeExperiences(): ProductExperienceSummary[] {
  return [
    {
      id: "exp-1",
      title: "Frontend Developer @ Acme",
      organization: "Acme",
      role: "Frontend Developer",
      startDate: "2022-01",
      endDate: "2024-01",
      category: "work",
      content: "Built React components.",
      status: "active",
      currentRevisionId: "rev-1",
      sourceDocumentId: undefined,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ];
}

function baseVariant(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    content: "Resume content for Acme.",
    score: { overall: 0.8, relevance: 0.8, evidenceStrength: 0.8 },
    reason: "ok",
    sourceExperienceIds: ["exp-1"],
    ...extra,
  };
}

const VALID_DOCUMENT = {
  schemaVersion: 1,
  sections: [
    {
      id: "sec-1",
      type: "experience",
      title: "工作经历",
      order: 0,
      items: [
        {
          id: "item-1",
          title: "高级前端工程师",
          subtitle: "Acme",
          period: "2022-2024",
          bullets: [
            { id: "b-1", text: "主导组件库重构", evidenceIds: ["exp-1"] },
            { id: "b-2", text: "推动 SSR 上线" },
          ],
          sourceExperienceId: "exp-1",
          evidenceStrength: "high",
          relevanceScore: 0.9,
        },
      ],
    },
  ],
};

describe("LLMGenerationService — resumeDocument schema", () => {
  const jdText = "React TypeScript developer needed.";
  const targetRole = "Frontend Engineer";

  it("accepts and passes through a valid resumeDocument", async () => {
    const service = new LLMGenerationService(
      fakeModelClient({ variants: [baseVariant({ resumeDocument: VALID_DOCUMENT })] }),
    );
    const result = await service.generateVariants("u-1", jdText, targetRole, fakeExperiences());
    expect(result.variants).toHaveLength(1);
    const variant = result.variants[0];
    expect(variant.resumeDocument).toBeDefined();
    expect(variant.resumeDocument!.schemaVersion).toBe(1);
    expect(variant.resumeDocument!.sections).toHaveLength(1);
    expect(variant.resumeDocument!.sections[0].items[0].bullets).toHaveLength(2);
    expect(variant.resumeDocument!.sections[0].items[0].sourceExperienceId).toBe("exp-1");
  });

  it("silently drops resumeDocument when sections array is empty", async () => {
    const service = new LLMGenerationService(
      fakeModelClient({
        variants: [baseVariant({ resumeDocument: { schemaVersion: 1, sections: [] } })],
      }),
    );
    const result = await service.generateVariants("u-1", jdText, targetRole, fakeExperiences());
    expect(result.variants[0].resumeDocument).toBeUndefined();
    // Other fields untouched.
    expect(result.variants[0].content).toBe("Resume content for Acme.");
  });

  it("silently drops resumeDocument when schemaVersion is missing", async () => {
    const service = new LLMGenerationService(
      fakeModelClient({
        variants: [baseVariant({
          resumeDocument: { sections: VALID_DOCUMENT.sections },
        })],
      }),
    );
    const result = await service.generateVariants("u-1", jdText, targetRole, fakeExperiences());
    expect(result.variants[0].resumeDocument).toBeUndefined();
  });

  it("silently drops resumeDocument when an item has no id or empty title", async () => {
    const broken = {
      schemaVersion: 1,
      sections: [
        {
          id: "sec-1",
          type: "experience",
          title: "Work",
          order: 0,
          items: [
            {
              id: "",
              title: "",
              bullets: [{ id: "b-1", text: "" }],
            },
          ],
        },
      ],
    };
    const service = new LLMGenerationService(
      fakeModelClient({ variants: [baseVariant({ resumeDocument: broken })] }),
    );
    const result = await service.generateVariants("u-1", jdText, targetRole, fakeExperiences());
    expect(result.variants[0].resumeDocument).toBeUndefined();
  });

  it("silently drops resumeDocument when section type is unknown", async () => {
    const broken = {
      schemaVersion: 1,
      sections: [
        {
          id: "sec-1",
          type: "leadership",
          title: "Leadership",
          order: 0,
          items: VALID_DOCUMENT.sections[0].items,
        },
      ],
    };
    const service = new LLMGenerationService(
      fakeModelClient({ variants: [baseVariant({ resumeDocument: broken })] }),
    );
    const result = await service.generateVariants("u-1", jdText, targetRole, fakeExperiences());
    expect(result.variants[0].resumeDocument).toBeUndefined();
  });

  it("does not regress legacy variants that omit resumeDocument", async () => {
    const service = new LLMGenerationService(
      fakeModelClient({ variants: [baseVariant()] }),
    );
    const result = await service.generateVariants("u-1", jdText, targetRole, fakeExperiences());
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0].resumeDocument).toBeUndefined();
    expect(result.variants[0].content).toBe("Resume content for Acme.");
  });

  it("returns fallback comparisonMatrix when LLM does not provide one", async () => {
    const service = new LLMGenerationService(
      fakeModelClient({
        variants: [
          {
            content: "Variant A content",
            reason: "Generated from JD",
            scores: { overall: 0.85, relevance: 0.9, evidenceStrength: 0.8 },
            variantName: "通用版",
            summary: "适合全栈投递",
            scenario: "通用全栈",
            riskSummary: { level: "medium" },
          },
          {
            content: "Variant B content",
            reason: "Generated from JD",
            scores: { overall: 0.72, relevance: 0.7, evidenceStrength: 0.75 },
            variantName: "精简版",
            summary: "突出项目",
            scenario: "项目导向",
            riskSummary: { level: "low" },
          },
        ],
      }),
    );
    const result = await service.generateVariants("u-1", jdText, targetRole, fakeExperiences());
    expect(result.recommendedVariantId).toBeDefined();
    expect(result.comparisonMatrix).toBeDefined();
    expect(result.comparisonMatrix!.length).toBeGreaterThanOrEqual(3);
    expect(result.comparisonMatrix![0].dimension).toBeDefined();
    expect(Object.keys(result.comparisonMatrix![0].values).length).toBe(2);
  });
});
