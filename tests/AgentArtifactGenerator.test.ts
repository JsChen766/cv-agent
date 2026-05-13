import { describe, expect, it } from "vitest";
import { AgentArtifactGenerator } from "../src/application/generators/AgentArtifactGenerator.js";
import { ModelClient } from "../src/core/model/ModelClient.js";
import type { LLMProvider } from "../src/core/model/LLMProvider.js";
import type { LLMChatRequest, LLMChatResponse } from "../src/core/model/types.js";
import { ArchitectAgent } from "../src/agents/ArchitectAgent.js";
import { GeneratedArtifactSchema } from "../src/knowledge/schemas/GeneratedArtifactSchema.js";
import type { JDRequirement, Evidence, Experience } from "../src/knowledge/types.js";
import type { RetrievedExperience } from "../src/knowledge/retrieval/ExperienceRetriever.js";

function fakeProvider(response: string): LLMProvider {
  return {
    name: "fake",
    async chat(_request: LLMChatRequest): Promise<LLMChatResponse> {
      return { content: response, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    },
  };
}

function makeRetrievedExperience(): RetrievedExperience {
  const experience: Experience = {
    id: "exp-1",
    userId: "user-1",
    type: "work",
    organization: "Acme Corp",
    role: "Frontend Engineer",
    summary: "Built a React design system.",
    timeRange: { startDate: null, endDate: null },
    star: { situation: "x", task: "x", action: "x", result: "40% improvement" },
    evidenceIds: ["ev-1", "ev-2"],
    skillIds: ["skill-react", "skill-ts"],
    confidence: 0.85,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  const evidences: Evidence[] = [
    { id: "ev-1", userId: "user-1", experienceId: "exp-1", sourceType: "raw_input", evidenceType: "project", sourceRef: "test", excerpt: "Built React components", confidence: 0.9, createdAt: "2024-01-01T00:00:00Z" },
    { id: "ev-2", userId: "user-1", experienceId: "exp-1", sourceType: "raw_input", evidenceType: "metric", sourceRef: "test", excerpt: "Reduced bundle size by 40%", confidence: 0.92, createdAt: "2024-01-01T00:00:00Z" },
  ];

  const skills = [
    { id: "skill-react", userId: "user-1", name: "React", category: "technical" as const, evidenceIds: ["ev-1"], createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" },
    { id: "skill-ts", userId: "user-1", name: "TypeScript", category: "technical" as const, evidenceIds: ["ev-2"], createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" },
  ];

  return {
    experience,
    evidences,
    skills,
    matchedEvidences: evidences,
    matchedSkills: skills,
    matchedRequirements: [],
    matchScore: 0.85,
    matchedRequirementIds: [],
    matchedEvidenceIds: ["ev-1", "ev-2"],
    matchedSkillIds: ["skill-react", "skill-ts"],
    reason: "Matched React and TypeScript skills",
  };
}

function makeRequirement(): JDRequirement {
  return {
    id: "req-1",
    userId: "user-1",
    jdId: "jd-1",
    description: "React experience",
    requiredSkillIds: ["skill-react"],
    weight: 1,
    createdAt: "2024-01-01T00:00:00Z",
  };
}

describe("AgentArtifactGenerator", () => {
  it("parses and validates valid JSON agent output", async () => {
    const provider = fakeProvider(
      JSON.stringify([
        {
          type: "resume_bullet",
          content: "Built React design system at Acme Corp, reducing bundle size by 40%.",
          sourceExperienceIds: ["exp-1"],
          sourceEvidenceIds: ["ev-1", "ev-2"],
          matchedSkillIds: ["skill-react", "skill-ts"],
          targetRequirementIds: ["req-1"],
        },
        {
          type: "resume_bullet",
          content: "Improved accessibility using WCAG patterns.",
          sourceExperienceIds: ["exp-1"],
          sourceEvidenceIds: ["ev-1"],
          matchedSkillIds: ["skill-react"],
          targetRequirementIds: ["req-1"],
        },
        {
          type: "resume_summary",
          content: "Experienced Frontend Engineer with strong React and TypeScript skills.",
          sourceExperienceIds: ["exp-1"],
          sourceEvidenceIds: ["ev-1", "ev-2"],
          matchedSkillIds: ["skill-react", "skill-ts"],
          targetRequirementIds: ["req-1"],
        },
      ]),
    );
    const modelClient = new ModelClient({ provider, defaultModel: "fake" });
    const agent = new ArchitectAgent({ modelClient });
    const generator = new AgentArtifactGenerator(agent);

    const result = await generator.generate({
      userId: "user-1",
      jdId: "jd-1",
      jdText: "Looking for React experience.",
      targetRole: "Frontend Engineer",
      requirements: [makeRequirement()],
      retrievedExperiences: [makeRetrievedExperience()],
    });

    expect(result).toHaveLength(3);
    for (const artifact of result) {
      expect(GeneratedArtifactSchema.safeParse(artifact).success).toBe(true);
      expect(artifact.userId).toBe("user-1");
      expect(artifact.targetJDId).toBe("jd-1");
    }
    expect(result[0].status).toBe("ready");
    expect(result[0].sourceEvidenceIds.length).toBeGreaterThan(0);
  });

  it("allows needs_review status when evidence is empty", async () => {
    const provider = fakeProvider(
      JSON.stringify([
        {
          type: "resume_bullet",
          content: "Draft bullet - no evidence available.",
          sourceExperienceIds: ["exp-1"],
          sourceEvidenceIds: [],
          matchedSkillIds: [],
          targetRequirementIds: [],
        },
        {
          type: "resume_bullet",
          content: "Another draft bullet.",
          sourceExperienceIds: ["exp-1"],
          sourceEvidenceIds: [],
          matchedSkillIds: [],
          targetRequirementIds: [],
        },
        {
          type: "resume_bullet",
          content: "Third draft bullet.",
          sourceExperienceIds: [],
          sourceEvidenceIds: [],
          matchedSkillIds: [],
          targetRequirementIds: [],
        },
      ]),
    );
    const modelClient = new ModelClient({ provider, defaultModel: "fake" });
    const agent = new ArchitectAgent({ modelClient });
    const generator = new AgentArtifactGenerator(agent);

    const result = await generator.generate({
      userId: "user-1",
      jdId: "jd-1",
      jdText: "test",
      targetRole: "Engineer",
      requirements: [],
      retrievedExperiences: [makeRetrievedExperience()],
    });

    expect(result).toHaveLength(3);
    for (const artifact of result) {
      expect(GeneratedArtifactSchema.safeParse(artifact).success).toBe(true);
    }
    // The one with empty arrays should be needs_review
    const needsReview = result.filter((a) => a.status === "needs_review");
    expect(needsReview.length).toBeGreaterThan(0);
  });

  it("throws on invalid JSON", async () => {
    const provider = fakeProvider("not json");
    const modelClient = new ModelClient({ provider, defaultModel: "fake" });
    const agent = new ArchitectAgent({ modelClient });
    const generator = new AgentArtifactGenerator(agent);

    await expect(
      generator.generate({
        userId: "user-1",
        jdId: "jd-1",
        jdText: "test",
        targetRole: "test",
        requirements: [],
        retrievedExperiences: [],
      }),
    ).rejects.toThrow("not valid JSON");
  });

  it("throws when fewer than 3 artifacts returned", async () => {
    const provider = fakeProvider(
      JSON.stringify([
        { type: "resume_bullet", content: "Only one.", sourceExperienceIds: [], sourceEvidenceIds: [], matchedSkillIds: [], targetRequirementIds: [] },
      ]),
    );
    const modelClient = new ModelClient({ provider, defaultModel: "fake" });
    const agent = new ArchitectAgent({ modelClient });
    const generator = new AgentArtifactGenerator(agent);

    await expect(
      generator.generate({
        userId: "user-1",
        jdId: "jd-1",
        jdText: "test",
        targetRole: "test",
        requirements: [],
        retrievedExperiences: [],
      }),
    ).rejects.toThrow("expected at least 3 artifacts");
  });

  it("filters out IDs not in the input", async () => {
    // Agent returns IDs that don't match any input experience/evidence
    const provider = fakeProvider(
      JSON.stringify([
        {
          type: "resume_bullet",
          content: "Bullet 1",
          sourceExperienceIds: ["exp-1", "exp-fake"],
          sourceEvidenceIds: ["ev-1", "ev-fake"],
          matchedSkillIds: ["skill-react", "skill-fake"],
          targetRequirementIds: ["req-1", "req-fake"],
        },
        {
          type: "resume_bullet",
          content: "Bullet 2",
          sourceExperienceIds: ["exp-1"],
          sourceEvidenceIds: ["ev-1"],
          matchedSkillIds: ["skill-react"],
          targetRequirementIds: ["req-1"],
        },
        {
          type: "resume_bullet",
          content: "Bullet 3",
          sourceExperienceIds: ["exp-1"],
          sourceEvidenceIds: ["ev-2"],
          matchedSkillIds: ["skill-ts"],
          targetRequirementIds: ["req-1"],
        },
      ]),
    );
    const modelClient = new ModelClient({ provider, defaultModel: "fake" });
    const agent = new ArchitectAgent({ modelClient });
    const generator = new AgentArtifactGenerator(agent);

    const result = await generator.generate({
      userId: "user-1",
      jdId: "jd-1",
      jdText: "test",
      targetRole: "Engineer",
      requirements: [makeRequirement()],
      retrievedExperiences: [makeRetrievedExperience()],
    });

    // First artifact should have filtered out the fake IDs
    expect(result[0].sourceExperienceIds).not.toContain("exp-fake");
    expect(result[0].sourceEvidenceIds).not.toContain("ev-fake");
    expect(result[0].matchedSkillIds).not.toContain("skill-fake");
    expect(result[0].targetRequirementIds).not.toContain("req-fake");
    // But real IDs should be kept
    expect(result[0].sourceExperienceIds).toContain("exp-1");
    expect(result[0].sourceEvidenceIds).toContain("ev-1");
  });
});
