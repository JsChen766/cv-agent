import { describe, expect, it } from "vitest";
import { ModelClient } from "../src/core/model/ModelClient.js";
import type { LLMProvider } from "../src/core/model/LLMProvider.js";
import type { LLMChatRequest, LLMChatResponse } from "../src/core/model/types.js";
import { LLMExperienceExtractor } from "../src/knowledge/index.js";
import type { ExtractedExperience } from "../src/knowledge/ingestion/extractors/types.js";

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

function firstExperience(result: { experiences: ExtractedExperience[] }): ExtractedExperience {
  const experience = result.experiences[0];
  if (!experience) {
    throw new Error("Expected one extracted experience.");
  }
  return experience;
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

    expect(result.experiences).toHaveLength(1);
    const experience = firstExperience(result);
    expect(experience.organization).toBe("Acme Corp");
    expect(experience.evidenceExcerpts).toHaveLength(2);
    expect(experience.skillNames?.map((skill) => skill.name)).toEqual([
      "React",
      "PostgreSQL",
      "TypeScript",
      "Performance Optimization",
    ]);
    expect(experience.metadata?.sourceDocumentId).toBe("doc-1");
    expect(experience.metadata?.llm).toMatchObject({
      provider: "sequence",
      repaired: false,
      fallbackUsed: false,
      truncated: false,
      experienceIndex: 0,
      totalExtractedExperiences: 1,
    });
    expect(provider.requests[0]?.responseFormat).toBe("json");
    expect(provider.requests[0]?.temperature).toBe(0);
  });

  it("returns all experiences when LLM returns multiple", async () => {
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

    expect(result.experiences).toHaveLength(2);
    expect(result.experiences.map((experience) => experience.summary)).toEqual([
      "First experience.",
      "Second experience.",
    ]);
    expect(result.warnings).toContain("LLM returned 2 experiences.");
    expect(result.warnings).not.toContain("LLM returned 2 experiences; only the first was ingested.");
    expect(result.experiences[0]?.metadata?.llm).toMatchObject({
      experienceIndex: 0,
      totalExtractedExperiences: 2,
    });
    expect(result.experiences[1]?.metadata?.llm).toMatchObject({
      experienceIndex: 1,
      totalExtractedExperiences: 2,
    });
    expect(result.experiences[0]?.skillNames?.map((skill) => skill.name)).toEqual(["React"]);
    expect(result.experiences[1]?.skillNames?.map((skill) => skill.name)).toEqual(["TypeScript"]);
  });

  it("repairs invalid JSON once and preserves multiple experiences", async () => {
    const { extractor, provider } = createExtractor({
      responses: ["not json", llmOutput({
        experiences: [
          {
            type: "project",
            summary: "First repaired experience.",
            evidences: [{ excerpt: "First repaired evidence.", skillNames: ["React"] }],
            skills: [{ name: "React" }],
          },
          {
            type: "project",
            summary: "Second repaired experience.",
            evidences: [{ excerpt: "Second repaired evidence.", skillNames: ["PostgreSQL"] }],
            skills: [{ name: "PostgreSQL" }],
          },
        ],
      })],
    });

    const result = await extractor.extract({
      userId: "user-1",
      rawText: "Built React systems.",
    });

    expect(result.experiences).toHaveLength(2);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.messages.at(-1)?.content).toContain("Convert the invalid extraction response");
    expect(result.experiences[0]?.metadata?.llm).toMatchObject({ repaired: true });
    expect(result.experiences[1]?.skillNames?.map((skill) => skill.name)).toEqual(["PostgreSQL"]);
  });

  it("falls back to deterministic extraction when repair fails", async () => {
    const { extractor } = createExtractor({
      responses: ["not json", "still not json"],
    });

    const result = await extractor.extract({
      userId: "user-1",
      rawText: "As a Frontend Engineer at Acme Corp, I built a React component library.",
    });

    expect(result.experiences).toHaveLength(1);
    const experience = firstExperience(result);
    expect(experience.organization).toBe("Acme Corp");
    expect(result.warnings[0]).toContain("LLMExperienceExtractor fell back to deterministic extraction");
    expect(experience.metadata?.llm).toMatchObject({
      fallbackUsed: true,
      experienceIndex: 0,
      totalExtractedExperiences: 1,
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
