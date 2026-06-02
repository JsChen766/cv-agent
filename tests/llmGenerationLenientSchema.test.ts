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
      content: "Built React components, improved performance by 40%.",
      status: "active",
      currentRevisionId: "rev-1",
      sourceDocumentId: undefined,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: "exp-2",
      title: "Data Analyst @ Beta",
      organization: "Beta",
      role: "Data Analyst",
      startDate: "2021-06",
      endDate: "2022-12",
      category: "work",
      content: "Analyzed user data with Python and SQL.",
      status: "active",
      currentRevisionId: "rev-2",
      sourceDocumentId: undefined,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ];
}

describe("LLMGenerationService — lenient schema normalization", () => {
  const jdText = "React TypeScript developer needed.";
  const targetRole = "Frontend Engineer";

  it("accepts evidenceSummary.items as string[] and normalizes to objects", async () => {
    const rawOutput = {
      variants: [{
        content: "Experienced frontend developer with React.",
        score: { overall: 0.8, relevance: 0.9, evidenceStrength: 0.7 },
        reason: "Good match for the JD.",
        sourceExperienceIds: ["exp-1"],
        evidenceSummary: {
          coverageLabel: "Based on experience library.",
          items: ["React expertise from Acme project", "Performance optimization experience"],
        },
      }],
    };

    const service = new LLMGenerationService(fakeModelClient(rawOutput));
    const result = await service.generateVariants("user-1", jdText, targetRole, fakeExperiences());

    expect(result.length).toBe(1);
    expect(result[0].content).toContain("Experienced frontend");
    expect(result[0].evidenceSummary).toBeDefined();
    expect(result[0].evidenceSummary!.items.length).toBe(2);
    // First string item normalized to object
    expect(result[0].evidenceSummary!.items[0].id).toBe("evidence-1");
    expect(result[0].evidenceSummary!.items[0].title).toBe("React expertise from Acme project");
    expect(result[0].evidenceSummary!.items[0].explanation).toBe("React expertise from Acme project");
    expect(result[0].evidenceSummary!.items[0].confidence).toBe(0.6);
    // Second string item
    expect(result[0].evidenceSummary!.items[1].id).toBe("evidence-2");
  });

  it("normalizes score=85 to 0.85 (scale 0-100 → 0-1)", async () => {
    const rawOutput = {
      variants: [{
        content: "Vue developer experience.",
        score: { overall: 85, relevance: 90, evidenceStrength: 70 },
        reason: "Strong match.",
        sourceExperienceIds: [],
      }],
    };

    const service = new LLMGenerationService(fakeModelClient(rawOutput));
    const result = await service.generateVariants("user-1", jdText, targetRole, fakeExperiences());

    expect(result.length).toBe(1);
    expect(result[0].scores?.overall).toBe(0.85);
    expect(result[0].scores?.relevance).toBe(0.9);
    expect(result[0].scores?.evidenceStrength).toBe(0.7);
  });

  it("normalizes score='0.8' string to 0.8", async () => {
    const rawOutput = {
      variants: [{
        content: "React developer experience.",
        score: { overall: "0.8", relevance: "0.85", evidenceStrength: "0.75" },
        reason: "Good match.",
        sourceExperienceIds: [],
      }],
    };

    const service = new LLMGenerationService(fakeModelClient(rawOutput));
    const result = await service.generateVariants("user-1", jdText, targetRole, fakeExperiences());

    expect(result.length).toBe(1);
    expect(result[0].scores?.overall).toBe(0.8);
    expect(result[0].scores?.relevance).toBe(0.85);
    expect(result[0].scores?.evidenceStrength).toBe(0.75);
  });

  it("fills default reason when missing", async () => {
    const rawOutput = {
      variants: [{
        content: "Angular developer experience.",
        score: { overall: 0.7, relevance: 0.7, evidenceStrength: 0.5 },
        sourceExperienceIds: [],
      }],
    };

    const service = new LLMGenerationService(fakeModelClient(rawOutput));
    const result = await service.generateVariants("user-1", jdText, targetRole, fakeExperiences());

    expect(result.length).toBe(1);
    expect(result[0].reason).toBe("Generated based on JD and experience library.");
  });

  it("fills default scores when score object is missing", async () => {
    const rawOutput = {
      variants: [{
        content: "Backend developer experience.",
        reason: "Relevant skills.",
        sourceExperienceIds: [],
      }],
    };

    const service = new LLMGenerationService(fakeModelClient(rawOutput));
    const result = await service.generateVariants("user-1", jdText, targetRole, fakeExperiences());

    expect(result.length).toBe(1);
    expect(result[0].scores?.overall).toBe(0.7);
    expect(result[0].scores?.relevance).toBe(0.7);
    expect(result[0].scores?.evidenceStrength).toBe(0.5);
  });

  it("keeps good variants and discards empty-content variants", async () => {
    const rawOutput = {
      variants: [
        { content: "", score: { overall: 0.5 }, reason: "bad" },
        { content: "Valid content here.", score: { overall: 0.9 }, reason: "good" },
        { content: null, score: {}, reason: "also bad" },
        { content: "Another valid one.", score: { overall: 0.8 }, reason: "good" },
      ],
    };

    const service = new LLMGenerationService(fakeModelClient(rawOutput));
    const result = await service.generateVariants("user-1", jdText, targetRole, fakeExperiences());

    expect(result.length).toBe(2);
    expect(result[0].content).toBe("Valid content here.");
    expect(result[1].content).toBe("Another valid one.");
  });

  it("also works when evidenceSummary.items has incomplete object fields", async () => {
    const rawOutput = {
      variants: [{
        content: "Full stack experience.",
        score: { overall: 0.8, relevance: 0.8, evidenceStrength: 0.6 },
        reason: "Match.",
        sourceExperienceIds: [],
        evidenceSummary: {
          coverageLabel: "Based on library.",
          items: [
            { title: "Only title" },
            { explanation: "Only explanation" },
            {}, // empty object
          ],
        },
      }],
    };

    const service = new LLMGenerationService(fakeModelClient(rawOutput));
    const result = await service.generateVariants("user-1", jdText, targetRole, fakeExperiences());

    expect(result.length).toBe(1);
    expect(result[0].evidenceSummary).toBeDefined();
    const items = result[0].evidenceSummary!.items;
    expect(items.length).toBe(3);
    // All items should have the required fields
    for (const item of items) {
      expect(typeof item.id).toBe("string");
      expect(typeof item.title).toBe("string");
      expect(typeof item.explanation).toBe("string");
      expect(typeof item.confidence).toBe("number");
    }
  });

  it("throws when all variants have empty content", async () => {
    const rawOutput = {
      variants: [
        { content: "", score: {}, reason: "" },
        { content: null, score: {}, reason: "" },
      ],
    };

    const service = new LLMGenerationService(fakeModelClient(rawOutput));
    await expect(
      service.generateVariants("user-1", jdText, targetRole, fakeExperiences()),
    ).rejects.toThrow(/no valid resume variants/i);
  });

  it("accepts raw array (not wrapped in {variants:})", async () => {
    const rawOutput = [{
      content: "Direct array variant.",
      score: { overall: 0.9, relevance: 0.9, evidenceStrength: 0.8 },
      reason: "Good.",
      sourceExperienceIds: [],
    }];

    const service = new LLMGenerationService(fakeModelClient(rawOutput));
    const result = await service.generateVariants("user-1", jdText, targetRole, fakeExperiences());

    expect(result.length).toBe(1);
    expect(result[0].content).toBe("Direct array variant.");
  });
});
