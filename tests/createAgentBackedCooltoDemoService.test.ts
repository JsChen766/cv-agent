import { describe, expect, it } from "vitest";
import { ArchitectAgent } from "../src/agents/ArchitectAgent.js";
import { ArchivistAgent } from "../src/agents/ArchivistAgent.js";
import { StrategistAgent } from "../src/agents/StrategistAgent.js";
import { createAgentBackedCooltoDemoService } from "../src/application/factories/createAgentBackedCooltoDemoService.js";
import { ModelClient } from "../src/core/model/ModelClient.js";
import type { LLMProvider } from "../src/core/model/LLMProvider.js";
import type { LLMChatRequest, LLMChatResponse } from "../src/core/model/types.js";

const JSON_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function fakeAgentProvider(): LLMProvider {
  return {
    name: "fake",
    async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
      const userContent =
        [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
      const agentName = request.metadata?.agentName;

      if (agentName === "archivist") {
        return {
          content: JSON.stringify({
            type: "work",
            organization: "Acme Corp",
            role: "Senior Frontend Engineer",
            summary: "Led a React and TypeScript design system at Acme Corp.",
            evidenceExcerpts: [
              "Led a React and TypeScript design system at Acme Corp.",
              "Reduced bundle size by 40% with performance optimization.",
            ],
          }),
          usage: JSON_USAGE,
        };
      }

      if (agentName === "strategist") {
        return {
          content: JSON.stringify({
            requirements: [
              { description: "React and TypeScript experience", weight: 1 },
              { description: "Performance optimization experience", weight: 0.8 },
              { description: "Design system experience", weight: 0.7 },
            ],
          }),
          usage: JSON_USAGE,
        };
      }

      return {
        content: JSON.stringify(makeArtifacts(userContent)),
        usage: JSON_USAGE,
      };
    },
  };
}

function makeArtifacts(prompt: string) {
  const experienceId = prompt.match(/Experience: ([^ |]+)/)?.[1] ?? "exp-missing";
  const evidenceIds = Array.from(prompt.matchAll(/(exp-[a-z0-9]+-ev-\d+):/g)).map(
    (match) => match[1],
  );
  const skillIds = Array.from(new Set(prompt.match(/skill-[a-z0-9]+/g) ?? []));
  const requirementIds = Array.from(new Set(prompt.match(/req-[a-z0-9]+/g) ?? []));

  return [
    {
      type: "resume_bullet",
      content: "Led React and TypeScript design system work with measurable performance impact.",
      sourceExperienceIds: [experienceId],
      sourceEvidenceIds: evidenceIds,
      matchedSkillIds: skillIds,
      targetRequirementIds: requirementIds,
    },
    {
      type: "resume_bullet",
      content: "Reduced bundle size by 40% through performance optimization practices.",
      sourceExperienceIds: [experienceId],
      sourceEvidenceIds: evidenceIds,
      matchedSkillIds: skillIds,
      targetRequirementIds: requirementIds,
    },
    {
      type: "resume_summary",
      content: "Senior frontend engineer with React, TypeScript, design system, and performance experience.",
      sourceExperienceIds: [experienceId],
      sourceEvidenceIds: evidenceIds,
      matchedSkillIds: skillIds,
      targetRequirementIds: requirementIds,
    },
  ];
}

describe("createAgentBackedCooltoDemoService", () => {
  it("creates a runnable agent-backed demo service", async () => {
    const modelClient = new ModelClient({
      provider: fakeAgentProvider(),
      defaultModel: "fake",
    });

    const service = createAgentBackedCooltoDemoService({
      archivistAgent: new ArchivistAgent({ modelClient }),
      strategistAgent: new StrategistAgent({ modelClient }),
      architectAgent: new ArchitectAgent({ modelClient }),
    });

    const result = await service.run({
      userId: "user-1",
      rawExperienceText: [
        "Led a React and TypeScript design system at Acme Corp.",
        "Reduced bundle size by 40% with performance optimization.",
      ].join("\n"),
      jdText:
        "Looking for React, TypeScript, performance optimization, and design system experience.",
      targetRole: "Senior Frontend Engineer",
    });

    expect(result.ingest.experience.organization).toBe("Acme Corp");
    expect(result.ingest.evidences.length).toBeGreaterThan(0);
    expect(result.generation.requirements.length).toBeGreaterThan(0);
    expect(result.generation.artifacts.length).toBeGreaterThanOrEqual(3);
    expect(result.generation.coverageReport.items.length).toBe(result.generation.requirements.length);
    expect(result.generation.critiqueReport.items.length).toBe(result.generation.artifacts.length);
    for (const bundle of result.generation.artifacts) {
      expect(bundle.artifact).toBeDefined();
      expect(bundle.evidenceChain).toBeDefined();
      expect(bundle.graphView).toBeDefined();
    }
  });
});
