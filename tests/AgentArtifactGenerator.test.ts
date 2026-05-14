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
    evidenceIds: ["ev-1", "ev-2", "ev-3"],
    skillIds: ["skill-react", "skill-ts", "skill-performance"],
    confidence: 0.85,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  const evidences: Evidence[] = [
    { id: "ev-1", userId: "user-1", experienceId: "exp-1", sourceType: "raw_input", evidenceType: "project", sourceRef: "test", excerpt: "Built React components", confidence: 0.9, createdAt: "2024-01-01T00:00:00Z" },
    { id: "ev-2", userId: "user-1", experienceId: "exp-1", sourceType: "raw_input", evidenceType: "metric", sourceRef: "test", excerpt: "Reduced bundle size by 40%", confidence: 0.92, createdAt: "2024-01-01T00:00:00Z" },
    { id: "ev-3", userId: "user-1", experienceId: "exp-1", sourceType: "raw_input", evidenceType: "skill_proof", sourceRef: "test", excerpt: "Built TypeScript component APIs", confidence: 0.88, createdAt: "2024-01-01T00:00:00Z" },
  ];

  const skills = [
    { id: "skill-react", userId: "user-1", name: "React", category: "technical" as const, evidenceIds: ["ev-1"], createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" },
    { id: "skill-ts", userId: "user-1", name: "TypeScript", category: "technical" as const, evidenceIds: ["ev-3"], createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" },
    { id: "skill-performance", userId: "user-1", name: "Performance Optimization", category: "technical" as const, evidenceIds: ["ev-2"], createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" },
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

function makePerformanceRequirement(): JDRequirement {
  return {
    id: "req-2",
    userId: "user-1",
    jdId: "jd-1",
    description: "Performance optimization experience",
    requiredSkillIds: ["skill-performance"],
    weight: 0.9,
    createdAt: "2024-01-01T00:00:00Z",
  };
}

function makeAlignmentRequirement(id: string, description: string, requiredSkillIds: string[]): JDRequirement {
  return {
    id,
    userId: "user-1",
    jdId: "jd-1",
    description,
    requiredSkillIds,
    weight: 1,
    createdAt: "2024-01-01T00:00:00Z",
  };
}

function makeMixedRetrievedExperience(): RetrievedExperience {
  const experience: Experience = {
    id: "exp-align",
    userId: "user-1",
    type: "work",
    organization: "Acme Corp",
    role: "Senior Frontend Engineer",
    summary: "Led frontend platform work.",
    timeRange: { startDate: null, endDate: null },
    star: { situation: "x", task: "x", action: "x", result: "40% reduction" },
    evidenceIds: ["ev-scope", "ev-a11y", "ev-perf"],
    skillIds: ["skill-react", "skill-ts", "skill-accessibility", "skill-performance"],
    confidence: 0.85,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  const evidences: Evidence[] = [
    {
      id: "ev-scope",
      userId: "user-1",
      experienceId: "exp-align",
      sourceType: "raw_input",
      evidenceType: "scope",
      sourceRef: "test",
      excerpt: "Owned React and TypeScript frontend scope for the platform.",
      confidence: 0.9,
      createdAt: "2024-01-01T00:00:00Z",
    },
    {
      id: "ev-a11y",
      userId: "user-1",
      experienceId: "exp-align",
      sourceType: "raw_input",
      evidenceType: "skill_proof",
      sourceRef: "test",
      excerpt: "Built an accessible component library with WCAG patterns.",
      confidence: 0.9,
      createdAt: "2024-01-01T00:00:00Z",
    },
    {
      id: "ev-perf",
      userId: "user-1",
      experienceId: "exp-align",
      sourceType: "raw_input",
      evidenceType: "result",
      sourceRef: "test",
      excerpt: "Reduced bundle size by 40% through performance optimization.",
      confidence: 0.92,
      createdAt: "2024-01-01T00:00:00Z",
    },
  ];

  const skills = [
    {
      id: "skill-react",
      userId: "user-1",
      name: "React",
      category: "technical" as const,
      evidenceIds: ["ev-scope"],
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: "skill-ts",
      userId: "user-1",
      name: "TypeScript",
      category: "technical" as const,
      evidenceIds: ["ev-scope"],
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: "skill-accessibility",
      userId: "user-1",
      name: "Accessibility",
      category: "technical" as const,
      evidenceIds: ["ev-a11y"],
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: "skill-performance",
      userId: "user-1",
      name: "Performance Optimization",
      category: "technical" as const,
      evidenceIds: ["ev-perf"],
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ];

  return {
    experience,
    evidences,
    skills,
    matchedEvidences: evidences,
    matchedSkills: skills,
    matchedRequirements: [],
    matchScore: 0.9,
    matchedRequirementIds: [],
    matchedEvidenceIds: evidences.map((evidence) => evidence.id),
    matchedSkillIds: skills.map((skill) => skill.id),
    reason: "Matched frontend platform evidence",
  };
}

function makeBroadRetrievedExperience(): RetrievedExperience {
  const experience: Experience = {
    id: "exp-broad",
    userId: "user-1",
    type: "work",
    organization: "Acme Corp",
    role: "Senior Frontend Engineer",
    summary: "Led frontend platform work.",
    timeRange: { startDate: null, endDate: null },
    star: { situation: "x", task: "x", action: "x", result: "40% reduction" },
    evidenceIds: ["ev-scale", "ev-collab", "ev-impact"],
    skillIds: ["skill-design-system", "skill-performance"],
    confidence: 0.85,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  const evidences: Evidence[] = [
    {
      id: "ev-scale",
      userId: "user-1",
      experienceId: "exp-broad",
      sourceType: "raw_input",
      evidenceType: "scope",
      sourceRef: "test",
      excerpt: "Led a React design system project for 12 product teams.",
      confidence: 0.9,
      createdAt: "2024-01-01T00:00:00Z",
    },
    {
      id: "ev-collab",
      userId: "user-1",
      experienceId: "exp-broad",
      sourceType: "raw_input",
      evidenceType: "action",
      sourceRef: "test",
      excerpt: "Partnered with product and design teams on cross-team collaboration for the design system rollout.",
      confidence: 0.9,
      createdAt: "2024-01-01T00:00:00Z",
    },
    {
      id: "ev-impact",
      userId: "user-1",
      experienceId: "exp-broad",
      sourceType: "raw_input",
      evidenceType: "result",
      sourceRef: "test",
      excerpt: "Delivered measurable product impact by reducing bundle size by 40%.",
      confidence: 0.92,
      createdAt: "2024-01-01T00:00:00Z",
    },
  ];

  const skills = [
    {
      id: "skill-design-system",
      userId: "user-1",
      name: "Design System",
      category: "domain" as const,
      evidenceIds: ["ev-scale", "ev-collab"],
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: "skill-performance",
      userId: "user-1",
      name: "Performance Optimization",
      category: "technical" as const,
      evidenceIds: ["ev-impact"],
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ];

  return {
    experience,
    evidences,
    skills,
    matchedEvidences: evidences,
    matchedSkills: skills,
    matchedRequirements: [],
    matchScore: 0.9,
    matchedRequirementIds: [],
    matchedEvidenceIds: evidences.map((evidence) => evidence.id),
    matchedSkillIds: skills.map((skill) => skill.id),
    reason: "Matched frontend platform evidence",
  };
}

describe("AgentArtifactGenerator", () => {
  it("parses and validates valid JSON agent output", async () => {
    const provider = fakeProvider(
      `${JSON.stringify([
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
      ])}\nGenerated from evidence.`,
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

  it("aligns additional relevant evidence IDs from content, skills, and requirements", async () => {
    const provider = fakeProvider(
      JSON.stringify([
        {
          type: "resume_bullet",
          content: "Built React and TypeScript component APIs while reducing bundle size by 40%.",
          sourceExperienceIds: ["exp-1"],
          sourceEvidenceIds: ["ev-1"],
          matchedSkillIds: ["skill-react", "skill-ts", "skill-performance"],
          targetRequirementIds: ["req-1", "req-2"],
        },
        {
          type: "resume_bullet",
          content: "Built React component systems.",
          sourceExperienceIds: ["exp-1"],
          sourceEvidenceIds: ["ev-1"],
          matchedSkillIds: ["skill-react"],
          targetRequirementIds: ["req-1"],
        },
        {
          type: "resume_summary",
          content: "Frontend engineer with React, TypeScript, and performance experience.",
          sourceExperienceIds: ["exp-1"],
          sourceEvidenceIds: ["ev-1"],
          matchedSkillIds: ["skill-react", "skill-ts", "skill-performance"],
          targetRequirementIds: ["req-1", "req-2"],
        },
      ]),
    );
    const generator = new AgentArtifactGenerator(new ArchitectAgent({
      modelClient: new ModelClient({ provider, defaultModel: "fake" }),
    }));

    const result = await generator.generate({
      userId: "user-1",
      jdId: "jd-1",
      jdText: "Looking for React, TypeScript, and performance optimization.",
      targetRole: "Frontend Engineer",
      requirements: [makeRequirement(), makePerformanceRequirement()],
      retrievedExperiences: [makeRetrievedExperience()],
    });

    expect(result[0].sourceEvidenceIds).toEqual(["ev-1", "ev-2", "ev-3"]);
  });

  it("only supplements strongly relevant evidence for focused and composite bullets", async () => {
    const provider = fakeProvider(
      JSON.stringify([
        {
          type: "resume_bullet",
          content: "Reduced bundle size by 40%.",
          sourceExperienceIds: ["exp-align"],
          sourceEvidenceIds: [],
          matchedSkillIds: ["skill-performance", "skill-accessibility"],
          targetRequirementIds: ["req-perf", "req-a11y"],
        },
        {
          type: "resume_bullet",
          content: "Improved WCAG accessibility for a component library.",
          sourceExperienceIds: ["exp-align"],
          sourceEvidenceIds: [],
          matchedSkillIds: ["skill-accessibility", "skill-react", "skill-ts"],
          targetRequirementIds: ["req-a11y", "req-react"],
        },
        {
          type: "resume_bullet",
          content: "Built React and TypeScript work that reduced bundle size by 40%.",
          sourceExperienceIds: ["exp-align"],
          sourceEvidenceIds: [],
          matchedSkillIds: ["skill-react", "skill-ts", "skill-performance"],
          targetRequirementIds: ["req-react", "req-perf"],
        },
      ]),
    );
    const generator = new AgentArtifactGenerator(new ArchitectAgent({
      modelClient: new ModelClient({ provider, defaultModel: "fake" }),
    }));

    const result = await generator.generate({
      userId: "user-1",
      jdId: "jd-1",
      jdText: "Looking for React, TypeScript, accessibility, and performance.",
      targetRole: "Frontend Engineer",
      requirements: [
        makeAlignmentRequirement("req-react", "React and TypeScript", ["skill-react", "skill-ts"]),
        makeAlignmentRequirement("req-a11y", "Accessibility", ["skill-accessibility"]),
        makeAlignmentRequirement("req-perf", "Performance", ["skill-performance"]),
      ],
      retrievedExperiences: [makeMixedRetrievedExperience()],
    });

    expect(result[0].sourceEvidenceIds).toEqual(["ev-perf"]);
    expect(result[1].sourceEvidenceIds).toEqual(["ev-a11y"]);
    expect(result[2].sourceEvidenceIds).toEqual(["ev-scope", "ev-perf"]);
  });

  it("filters broad requirements unless content and linked evidence explicitly support them", async () => {
    const provider = fakeProvider(
      JSON.stringify([
        {
          type: "resume_bullet",
          content: "Reduced bundle size by 40%.",
          sourceExperienceIds: ["exp-broad"],
          sourceEvidenceIds: ["ev-impact"],
          matchedSkillIds: ["skill-performance"],
          targetRequirementIds: ["req-perf", "req-broad"],
        },
        {
          type: "resume_bullet",
          content: "Partnered with product and design teams through cross-team collaboration on the design system rollout.",
          sourceExperienceIds: ["exp-broad"],
          sourceEvidenceIds: ["ev-collab"],
          matchedSkillIds: ["skill-design-system"],
          targetRequirementIds: ["req-collab"],
        },
        {
          type: "resume_bullet",
          content: "Delivered measurable product impact by reducing bundle size by 40%.",
          sourceExperienceIds: ["exp-broad"],
          sourceEvidenceIds: ["ev-impact"],
          matchedSkillIds: ["skill-performance"],
          targetRequirementIds: ["req-impact"],
        },
        {
          type: "resume_bullet",
          content: "Led design system work for 12 product teams.",
          sourceExperienceIds: ["exp-broad"],
          sourceEvidenceIds: ["ev-scale"],
          matchedSkillIds: ["skill-design-system"],
          targetRequirementIds: ["req-collab"],
        },
      ]),
    );
    const generator = new AgentArtifactGenerator(new ArchitectAgent({
      modelClient: new ModelClient({ provider, defaultModel: "fake" }),
    }));

    const result = await generator.generate({
      userId: "user-1",
      jdId: "jd-1",
      jdText: "Looking for frontend platform impact and collaboration.",
      targetRole: "Frontend Engineer",
      requirements: [
        makeAlignmentRequirement("req-perf", "Performance optimization", ["skill-performance"]),
        makeAlignmentRequirement("req-broad", "Cross-team collaboration and product impact demonstrated", []),
        makeAlignmentRequirement("req-collab", "Cross-team collaboration", []),
        makeAlignmentRequirement("req-impact", "Measurable impact", []),
      ],
      retrievedExperiences: [makeBroadRetrievedExperience()],
    });

    expect(result[0].targetRequirementIds).toEqual(["req-perf"]);
    expect(result[1].targetRequirementIds).toEqual(["req-collab"]);
    expect(result[2].targetRequirementIds).toEqual(["req-impact"]);
    expect(result[3].targetRequirementIds).toEqual([]);
  });

  it("does not add unrelated evidence when content has no supporting match", async () => {
    const provider = fakeProvider(
      JSON.stringify([
        {
          type: "resume_bullet",
          content: "Improved performance for frontend applications.",
          sourceExperienceIds: ["exp-1"],
          sourceEvidenceIds: [],
          matchedSkillIds: [],
          targetRequirementIds: [],
        },
        {
          type: "resume_bullet",
          content: "Draft bullet.",
          sourceExperienceIds: ["exp-1"],
          sourceEvidenceIds: [],
          matchedSkillIds: [],
          targetRequirementIds: [],
        },
        {
          type: "resume_summary",
          content: "Draft summary.",
          sourceExperienceIds: ["exp-1"],
          sourceEvidenceIds: [],
          matchedSkillIds: [],
          targetRequirementIds: [],
        },
      ]),
    );
    const generator = new AgentArtifactGenerator(new ArchitectAgent({
      modelClient: new ModelClient({ provider, defaultModel: "fake" }),
    }));

    const result = await generator.generate({
      userId: "user-1",
      jdId: "jd-1",
      jdText: "Performance role.",
      targetRole: "Frontend Engineer",
      requirements: [],
      retrievedExperiences: [makeRetrievedExperience()],
    });

    expect(result[0].sourceEvidenceIds).toEqual([]);
    expect(result[0].status).toBe("needs_review");
  });

  it("does not align evidence when no retrieved experiences are available", async () => {
    const provider = fakeProvider(
      JSON.stringify([
        {
          type: "resume_bullet",
          content: "Built React components.",
          sourceExperienceIds: ["exp-1"],
          sourceEvidenceIds: ["ev-1"],
          matchedSkillIds: ["skill-react"],
          targetRequirementIds: ["req-1"],
        },
        {
          type: "resume_bullet",
          content: "Reduced bundle size by 40%.",
          sourceExperienceIds: ["exp-1"],
          sourceEvidenceIds: ["ev-2"],
          matchedSkillIds: ["skill-performance"],
          targetRequirementIds: ["req-2"],
        },
        {
          type: "resume_summary",
          content: "Frontend engineer.",
          sourceExperienceIds: ["exp-1"],
          sourceEvidenceIds: ["ev-1"],
          matchedSkillIds: ["skill-react"],
          targetRequirementIds: ["req-1"],
        },
      ]),
    );
    const generator = new AgentArtifactGenerator(new ArchitectAgent({
      modelClient: new ModelClient({ provider, defaultModel: "fake" }),
    }));

    const result = await generator.generate({
      userId: "user-1",
      jdId: "jd-1",
      jdText: "React role.",
      targetRole: "Frontend Engineer",
      requirements: [makeRequirement(), makePerformanceRequirement()],
      retrievedExperiences: [],
    });

    expect(result[0].sourceEvidenceIds).toEqual([]);
    expect(result[0].status).toBe("needs_review");
  });
});
