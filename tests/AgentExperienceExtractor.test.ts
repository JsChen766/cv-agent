import { describe, expect, it } from "vitest";
import { AgentExperienceExtractor } from "../src/knowledge/ingestion/extractors/AgentExperienceExtractor.js";
import { ModelClient } from "../src/core/model/ModelClient.js";
import type { LLMProvider } from "../src/core/model/LLMProvider.js";
import type { LLMChatRequest, LLMChatResponse } from "../src/core/model/types.js";
import { ArchivistAgent } from "../src/agents/ArchivistAgent.js";

function fakeProvider(response: string): LLMProvider {
  return {
    name: "fake",
    async chat(_request: LLMChatRequest): Promise<LLMChatResponse> {
      return {
        content: response,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  };
}

describe("AgentExperienceExtractor", () => {
  it("parses and validates valid JSON agent output", async () => {
    const provider = fakeProvider(
      JSON.stringify({
        type: "work",
        organization: "Acme Corp",
        role: "Frontend Engineer",
        summary: "Built a React design system at Acme Corp.",
        evidenceExcerpts: [
          "Built a React design system",
          "Reduced bundle size by 40%",
          "Improved accessibility",
        ],
      }),
    );
    const modelClient = new ModelClient({ provider, defaultModel: "fake" });
    const agent = new ArchivistAgent({ modelClient });
    const extractor = new AgentExperienceExtractor(agent);

    const result = await extractor.extract({
      userId: "user-1",
      rawText: "As a Frontend Engineer at Acme Corp, I built a React design system. Reduced bundle size by 40%. Improved accessibility.",
    });

    expect(result.type).toBe("work");
    expect(result.organization).toBe("Acme Corp");
    expect(result.role).toBe("Frontend Engineer");
    expect(result.summary).toContain("Acme Corp");
    expect(result.evidenceExcerpts).toHaveLength(3);
  });

  it("throws when agent returns invalid JSON", async () => {
    const provider = fakeProvider("not json at all");
    const modelClient = new ModelClient({ provider, defaultModel: "fake" });
    const agent = new ArchivistAgent({ modelClient });
    const extractor = new AgentExperienceExtractor(agent);

    await expect(
      extractor.extract({
        userId: "user-1",
        rawText: "some text",
      }),
    ).rejects.toThrow("not valid JSON");
  });

  it("throws when agent JSON fails zod validation", async () => {
    const provider = fakeProvider(
      JSON.stringify({ type: "invalid_type", organization: 123, role: null }),
    );
    const modelClient = new ModelClient({ provider, defaultModel: "fake" });
    const agent = new ArchivistAgent({ modelClient });
    const extractor = new AgentExperienceExtractor(agent);

    await expect(
      extractor.extract({
        userId: "user-1",
        rawText: "some text",
      }),
    ).rejects.toThrow("AgentExperienceExtractor");
  });

  it("handles education type experience", async () => {
    const provider = fakeProvider(
      JSON.stringify({
        type: "education",
        organization: "MIT",
        role: "Student",
        summary: "Studied computer science at MIT.",
        evidenceExcerpts: ["Completed CS coursework"],
      }),
    );
    const modelClient = new ModelClient({ provider, defaultModel: "fake" });
    const agent = new ArchivistAgent({ modelClient });
    const extractor = new AgentExperienceExtractor(agent);

    const result = await extractor.extract({
      userId: "user-1",
      rawText: "Studied computer science at MIT.",
    });

    expect(result.type).toBe("education");
    expect(result.organization).toBe("MIT");
  });
});
