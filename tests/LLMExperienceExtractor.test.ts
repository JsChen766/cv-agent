import { describe, expect, it } from "vitest";
import { ModelClient } from "../src/core/model/ModelClient.js";
import type { LLMProvider } from "../src/core/model/LLMProvider.js";
import type { LLMChatRequest, LLMChatResponse } from "../src/core/model/types.js";
import { LLMExperienceExtractor } from "../src/knowledge/index.js";

class SequenceProvider implements LLMProvider {
  public readonly name = "sequence";
  public readonly requests: LLMChatRequest[] = [];
  private index = 0;

  public constructor(private readonly responses: string[]) {}

  public async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    this.requests.push(request);
    const content = this.responses[Math.min(this.index, this.responses.length - 1)] ?? "";
    this.index += 1;
    return { content };
  }
}

function createExtractor(input: {
  responses: string[];
  allowJsonRepair?: boolean;
  allowFallbackToDeterministic?: boolean;
}): {
  extractor: LLMExperienceExtractor;
  provider: SequenceProvider;
} {
  const provider = new SequenceProvider(input.responses);
  return {
    provider,
    extractor: new LLMExperienceExtractor({
      modelClient: new ModelClient({
        provider,
        defaultModel: "fake",
        maxRetries: 0,
      }),
      allowJsonRepair: input.allowJsonRepair,
      allowFallbackToDeterministic: input.allowFallbackToDeterministic,
    }),
  };
}

function llmOutput(overrides: {
  experiences?: unknown[];
  warnings?: string[];
} = {}): string {
  return JSON.stringify({
    experiences: overrides.experiences ?? [{
      type: "work",
      organization: "Acme Corp",
      role: "Frontend Engineer",
      summary: "Built a React dashboard for analytics.",
      evidences: [
        {
          excerpt: "Built a React dashboard for internal analytics.",
          confidence: 0.9,
          skillNames: ["React", "TypeScript"],
        },
        {
          excerpt: "Reduced report preparation time from 2 hours to 20 minutes.",
          confidence: 0.92,
          skillNames: ["Performance Optimization"],
        },
      ],
      skills: [
        { name: "React", category: "technical" },
        { name: "PostgreSQL", category: "technical" },
      ],
    }],
    warnings: overrides.warnings ?? [],
  });
}

describe("LLMExperienceExtractor", () => {
  it("maps valid LLM output into extracted experience data", async () => {
    const { extractor, provider } = createExtractor({
      responses: [llmOutput()],
    });

    const result = await extractor.extract({
      userId: "user-1",
      rawText: "Built a React dashboard and reduced report preparation time.",
      sourceDocumentId: "doc-1",
      documentMetadata: {
        documentId: "doc-1",
        fileName: "resume.md",
        sourceType: "markdown",
        sourceRef: "upload:resume.md",
        parser: "markdown",
        textLength: 100,
      },
    });

    expect(result.organization).toBe("Acme Corp");
    expect(result.evidenceExcerpts).toHaveLength(2);
    expect(result.skillNames?.map((skill) => skill.name)).toEqual([
      "React",
      "PostgreSQL",
      "TypeScript",
      "Performance Optimization",
    ]);
    expect(result.metadata?.sourceDocumentId).toBe("doc-1");
    expect(result.metadata?.llm).toMatchObject({
      provider: "sequence",
      repaired: false,
      fallbackUsed: false,
      truncated: false,
    });
    expect(provider.requests[0]?.responseFormat).toBe("json");
    expect(provider.requests[0]?.temperature).toBe(0);
  });

  it("warns and chooses the first experience when LLM returns multiple", async () => {
    const { extractor } = createExtractor({
      responses: [llmOutput({
        experiences: [
          {
            type: "project",
            summary: "First experience.",
            evidences: [{ excerpt: "First evidence." }],
            skills: [{ name: "React" }],
          },
          {
            type: "work",
            summary: "Second experience.",
            evidences: [{ excerpt: "Second evidence." }],
            skills: [{ name: "TypeScript" }],
          },
        ],
      })],
    });

    const result = await extractor.extract({
      userId: "user-1",
      rawText: "First evidence. Second evidence.",
    });

    expect(result.summary).toBe("First experience.");
    expect(result.warnings).toContain("LLM returned 2 experiences; only the first was ingested.");
  });

  it("repairs invalid JSON once", async () => {
    const { extractor, provider } = createExtractor({
      responses: ["not json", llmOutput()],
    });

    const result = await extractor.extract({
      userId: "user-1",
      rawText: "Built React systems.",
    });

    expect(result.organization).toBe("Acme Corp");
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.messages.at(-1)?.content).toContain("Convert the invalid extraction response");
    expect(result.metadata?.llm).toMatchObject({ repaired: true });
  });

  it("falls back to deterministic extraction when repair fails", async () => {
    const { extractor } = createExtractor({
      responses: ["not json", "still not json"],
    });

    const result = await extractor.extract({
      userId: "user-1",
      rawText: "As a Frontend Engineer at Acme Corp, I built a React component library.",
    });

    expect(result.organization).toBe("Acme Corp");
    expect(result.warnings?.[0]).toContain("LLMExperienceExtractor fell back to deterministic extraction");
    expect(result.metadata?.llm).toMatchObject({
      fallbackUsed: true,
    });
  });

  it("throws when fallback is disabled", async () => {
    const { extractor } = createExtractor({
      responses: ["not json", "still not json"],
      allowFallbackToDeterministic: false,
    });

    await expect(extractor.extract({
      userId: "user-1",
      rawText: "Built React systems.",
    })).rejects.toThrow();
  });

  it("truncates long raw text and adds a warning", async () => {
    const { extractor, provider } = createExtractor({
      responses: [llmOutput()],
    });

    const result = await extractor.extract({
      userId: "user-1",
      rawText: "React ".repeat(3_000),
    });

    expect(result.warnings).toContain("Source text was truncated before LLM extraction.");
    expect(provider.requests[0]?.messages.at(-1)?.content.length).toBeLessThan(13_000);
  });
});
