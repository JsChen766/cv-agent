import { describe, expect, it } from "vitest";
import { AgentJDRequirementExtractor } from "../src/application/extractors/AgentJDRequirementExtractor.js";
import { ModelClient } from "../src/core/model/ModelClient.js";
import type { LLMProvider } from "../src/core/model/LLMProvider.js";
import type { LLMChatRequest, LLMChatResponse } from "../src/core/model/types.js";
import { StrategistAgent } from "../src/agents/StrategistAgent.js";
import { InMemoryJDRequirementRepository, InMemorySkillRepository } from "../src/knowledge/index.js";

function fakeProvider(response: string): LLMProvider {
  return {
    name: "fake",
    async chat(_request: LLMChatRequest): Promise<LLMChatResponse> {
      return { content: response, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    },
  };
}

describe("AgentJDRequirementExtractor", () => {
  it("parses and validates valid JSON agent output", async () => {
    const skillRepo = new InMemorySkillRepository();
    const requirementRepo = new InMemoryJDRequirementRepository();
    const provider = fakeProvider(
      `Here is the JSON: ${JSON.stringify({
        requirements: [
          { description: "Must have React experience", weight: 1.0 },
          { description: "Must know TypeScript", weight: 0.8 },
        ],
      })}`,
    );
    const modelClient = new ModelClient({ provider, defaultModel: "fake" });
    const agent = new StrategistAgent({ modelClient });
    const extractor = new AgentJDRequirementExtractor(agent, skillRepo, requirementRepo);

    const result = await extractor.extract({
      userId: "user-1",
      jdText: "Looking for React and TypeScript developers.",
      targetRole: "Frontend Engineer",
    });

    expect(result.jdId).toContain("jd-");
    expect(result.requirements).toHaveLength(2);
    expect(result.requirements[0].userId).toBe("user-1");
    expect(result.requirements[0].weight).toBe(1.0);
    expect(result.requirements[1].description).toBe("Must know TypeScript");

    const saved = await requirementRepo.listByUserId("user-1");
    expect(saved).toHaveLength(2);
  });

  it("throws on invalid JSON", async () => {
    const skillRepo = new InMemorySkillRepository();
    const requirementRepo = new InMemoryJDRequirementRepository();
    const provider = fakeProvider("not json");
    const modelClient = new ModelClient({ provider, defaultModel: "fake" });
    const agent = new StrategistAgent({ modelClient });
    const extractor = new AgentJDRequirementExtractor(agent, skillRepo, requirementRepo);

    await expect(
      extractor.extract({
        userId: "user-1",
        jdText: "test",
        targetRole: "test",
      }),
    ).rejects.toThrow("not valid JSON");
  });

  it("throws when zod validation fails (missing requirements array)", async () => {
    const skillRepo = new InMemorySkillRepository();
    const requirementRepo = new InMemoryJDRequirementRepository();
    const provider = fakeProvider(JSON.stringify({ wrong_field: [] }));
    const modelClient = new ModelClient({ provider, defaultModel: "fake" });
    const agent = new StrategistAgent({ modelClient });
    const extractor = new AgentJDRequirementExtractor(agent, skillRepo, requirementRepo);

    await expect(
      extractor.extract({
        userId: "user-1",
        jdText: "test",
        targetRole: "test",
      }),
    ).rejects.toThrow("AgentJDRequirementExtractor");
  });

  it("throws when requirements array is empty", async () => {
    const skillRepo = new InMemorySkillRepository();
    const requirementRepo = new InMemoryJDRequirementRepository();
    const provider = fakeProvider(JSON.stringify({ requirements: [] }));
    const modelClient = new ModelClient({ provider, defaultModel: "fake" });
    const agent = new StrategistAgent({ modelClient });
    const extractor = new AgentJDRequirementExtractor(agent, skillRepo, requirementRepo);

    await expect(
      extractor.extract({
        userId: "user-1",
        jdText: "test",
        targetRole: "test",
      }),
    ).rejects.toThrow("AgentJDRequirementExtractor");
  });
});
