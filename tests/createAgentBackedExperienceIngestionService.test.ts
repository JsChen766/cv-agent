import { describe, expect, it } from "vitest";
import { ArchivistAgent } from "../src/agents/ArchivistAgent.js";
import { createAgentBackedExperienceIngestionService } from "../src/application/factories/createAgentBackedExperienceIngestionService.js";
import { ModelClient } from "../src/core/model/ModelClient.js";
import type { LLMProvider } from "../src/core/model/LLMProvider.js";
import type { LLMChatRequest, LLMChatResponse } from "../src/core/model/types.js";
import {
  InMemoryEvidenceRepository,
  InMemoryExperienceRepository,
  InMemorySkillRepository,
} from "../src/knowledge/index.js";

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

describe("createAgentBackedExperienceIngestionService", () => {
  it("wires AgentExperienceExtractor into ExperienceIngestionService", async () => {
    const modelClient = new ModelClient({
      provider: fakeProvider(
        JSON.stringify({
          type: "work",
          organization: "Acme Corp",
          role: "Frontend Engineer",
          summary: "Built a React and TypeScript design system at Acme Corp.",
          evidenceExcerpts: [
            "Built a React and TypeScript design system at Acme Corp.",
            "Reduced bundle size by 40%.",
          ],
        }),
      ),
      defaultModel: "fake",
    });
    const archivistAgent = new ArchivistAgent({ modelClient });
    const experienceRepo = new InMemoryExperienceRepository();
    const evidenceRepo = new InMemoryEvidenceRepository();
    const skillRepo = new InMemorySkillRepository();

    const service = createAgentBackedExperienceIngestionService({
      archivistAgent,
      experienceRepo,
      evidenceRepo,
      skillRepo,
    });

    const result = await service.ingest({
      userId: "user-1",
      rawText: "Built a React and TypeScript design system at Acme Corp. Reduced bundle size by 40%.",
      sourceRef: "test",
      sourceType: "raw_input",
    });

    expect(result.experience.organization).toBe("Acme Corp");
    expect(result.evidences).toHaveLength(2);
    expect(result.skills.map((skill) => skill.name)).toEqual(
      expect.arrayContaining(["React", "TypeScript", "Design System"]),
    );
    await expect(experienceRepo.getById(result.experience.id)).resolves.toBeDefined();
  });
});
