import { describe, expect, it } from "vitest";
import { ModelClient } from "../src/core/model/ModelClient.js";
import type { LLMProvider } from "../src/core/model/LLMProvider.js";
import type { LLMChatRequest, LLMChatResponse } from "../src/core/model/types.js";
import { LLMArtifactGenerator } from "../src/application/generators/LLMArtifactGenerator.js";
import type { GenerateArtifactsInput } from "../src/application/generators/ArtifactGenerator.js";
import type { Evidence, Experience, JDRequirement, Skill } from "../src/knowledge/types.js";
import type { RetrievedExperience } from "../src/knowledge/retrieval/ExperienceRetriever.js";

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

function createGenerator(input: {
  responses: string[];
  allowJsonRepair?: boolean;
  allowFallbackToDeterministic?: boolean;
}): {
  generator: LLMArtifactGenerator;
  provider: SequenceProvider;
} {
  const provider = new SequenceProvider(input.responses);
  return {
    provider,
    generator: new LLMArtifactGenerator({
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

function makeInput(): GenerateArtifactsInput {
  const experience: Experience = {
    id: "exp-1",
    userId: "user-1",
    type: "work",
    organization: "Acme Corp",
    role: "BI Developer",
    summary: "Built BI dashboards and reporting automation.",
    timeRange: { startDate: null, endDate: null },
    star: {
      situation: "Manual reporting",
      task: "Improve reporting",
      action: "Built dashboards",
      result: "Reduced reporting time",
    },
    evidenceIds: ["ev-dashboard", "ev-report"],
    skillIds: ["skill-bi", "skill-sql"],
    confidence: 0.86,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };
  const evidences: Evidence[] = [
    {
      id: "ev-dashboard",
      userId: "user-1",
      experienceId: "exp-1",
      sourceType: "raw_input",
      evidenceType: "project",
      sourceRef: "test",
      excerpt: "Built 50+ Power BI dashboards for sales stakeholders.",
      confidence: 0.9,
      createdAt: "2024-01-01T00:00:00Z",
    },
    {
      id: "ev-report",
      userId: "user-1",
      experienceId: "exp-1",
      sourceType: "raw_input",
      evidenceType: "result",
      sourceRef: "test",
      excerpt: "Reduced report preparation time from 2 hours to 20 minutes.",
      confidence: 0.92,
      createdAt: "2024-01-01T00:00:00Z",
    },
  ];
  const skills: Skill[] = [
    {
      id: "skill-bi",
      userId: "user-1",
      name: "Power BI",
      category: "technical",
      evidenceIds: ["ev-dashboard"],
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: "skill-sql",
      userId: "user-1",
      name: "SQL",
      category: "technical",
      evidenceIds: ["ev-report"],
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ];
  const requirements: JDRequirement[] = [
    {
      id: "req-bi",
      userId: "user-1",
      jdId: "jd-1",
      description: "BI dashboard development",
      requiredSkillIds: ["skill-bi"],
      weight: 1,
      createdAt: "2024-01-01T00:00:00Z",
    },
  ];
  const retrieved: RetrievedExperience = {
    experience,
    evidences,
    skills,
    matchedEvidences: evidences,
    matchedSkills: skills,
    matchedRequirements: requirements,
    matchScore: 0.9,
    matchedRequirementIds: ["req-bi"],
    matchedEvidenceIds: evidences.map((evidence) => evidence.id),
    matchedSkillIds: skills.map((skill) => skill.id),
    reason: "Matched BI evidence",
  };
  return {
    userId: "user-1",
    jdId: "jd-1",
    jdText: "Need BI dashboard, SQL, and stakeholder communication experience.",
    targetRole: "BI Analyst",
    requirements,
    experiences: [experience],
    evidences,
    skills,
    retrievedExperiences: [retrieved],
  };
}

function outputArtifact(overrides: Partial<{
  content: string;
  status: "ready" | "needs_confirmation" | "unsafe";
  supportLevel: "supported" | "inferred" | "needs_user_confirmation" | "unsupported";
  riskLevel: "low" | "medium" | "high";
  confirmationQuestions: string[];
  enhancementStrategy: "evidence_rewrite" | "reasonable_inference" | "confirmation_needed" | "unsafe_candidate";
}> = {}) {
  const content = overrides.content ?? "Built 50+ Power BI dashboards for sales stakeholders.";
  const supportLevel = overrides.supportLevel ?? "supported";
  return {
    artifacts: [{
      content,
      targetRequirementIds: ["req-bi"],
      sourceExperienceIds: ["exp-1"],
      sourceEvidenceIds: ["ev-dashboard"],
      claims: [{
        text: content,
        supportLevel,
        riskLevel: overrides.riskLevel ?? "low",
        evidenceIds: supportLevel === "needs_user_confirmation" || supportLevel === "unsupported"
          ? []
          : ["ev-dashboard"],
        sourceExperienceIds: ["exp-1"],
        ...(supportLevel === "needs_user_confirmation"
          ? { userConfirmationPrompt: "Can you confirm this metric?" }
          : {}),
      }],
      status: overrides.status ?? "ready",
      confirmationQuestions: overrides.confirmationQuestions ?? [],
      enhancementStrategy: overrides.enhancementStrategy ?? "evidence_rewrite",
      rationale: "Grounded in dashboard evidence.",
    }],
    warnings: [],
  };
}

function enhancement(artifact: { metadata?: Record<string, unknown> }): Record<string, unknown> {
  const value = artifact.metadata?.enhancement;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Missing enhancement metadata.");
  }
  return value as Record<string, unknown>;
}

describe("LLMArtifactGenerator", () => {
  it("maps valid LLM output into generated artifacts", async () => {
    const { generator, provider } = createGenerator({
      responses: [JSON.stringify(outputArtifact())],
    });

    const result = await generator.generate(makeInput());

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.content).toContain("Power BI");
    expect(result.artifacts[0]?.sourceExperienceIds).toEqual(["exp-1"]);
    expect(result.artifacts[0]?.sourceEvidenceIds).toEqual(["ev-dashboard"]);
    expect(result.artifacts[0]?.matchedSkillIds).toContain("skill-bi");
    expect(enhancement(result.artifacts[0] ?? {}).status).toBe("ready");
    expect(provider.requests[0]?.responseFormat).toBe("json");
    expect(provider.requests[0]?.temperature).toBe(0.2);
  });

  it("keeps ready artifacts with supported and inferred claims", async () => {
    const { generator } = createGenerator({
      responses: [JSON.stringify(outputArtifact({
        supportLevel: "inferred",
        enhancementStrategy: "reasonable_inference",
      }))],
    });

    const result = await generator.generate(makeInput());
    const meta = enhancement(result.artifacts[0] ?? {});

    expect(meta.status).toBe("ready");
    expect(meta.enhancementStrategy).toBe("reasonable_inference");
  });

  it("maps needs_confirmation artifacts with confirmation questions", async () => {
    const { generator } = createGenerator({
      responses: [JSON.stringify(outputArtifact({
        content: "Improved dashboard adoption by 30%.",
        status: "needs_confirmation",
        supportLevel: "needs_user_confirmation",
        riskLevel: "medium",
        confirmationQuestions: ["Can you confirm dashboard adoption improved by 30%?"],
        enhancementStrategy: "confirmation_needed",
      }))],
    });

    const result = await generator.generate(makeInput());
    const meta = enhancement(result.artifacts[0] ?? {});

    expect(result.artifacts[0]?.status).toBe("needs_review");
    expect(meta.status).toBe("needs_confirmation");
    expect(meta.confirmationQuestions).toEqual(["Can you confirm dashboard adoption improved by 30%?"]);
  });

  it("maps unsupported high-risk claims marked unsafe", async () => {
    const { generator } = createGenerator({
      responses: [JSON.stringify(outputArtifact({
        content: "Owned company-wide BI strategy.",
        status: "unsafe",
        supportLevel: "unsupported",
        riskLevel: "high",
        enhancementStrategy: "unsafe_candidate",
      }))],
    });

    const result = await generator.generate(makeInput());
    const meta = enhancement(result.artifacts[0] ?? {});

    expect(result.artifacts[0]?.status).toBe("needs_review");
    expect(meta.status).toBe("unsafe");
  });

  it("repairs invalid JSON once", async () => {
    const { generator, provider } = createGenerator({
      responses: ["not json", JSON.stringify(outputArtifact())],
    });

    const result = await generator.generate(makeInput());

    expect(result.artifacts).toHaveLength(1);
    expect(provider.requests).toHaveLength(2);
    expect(enhancement(result.artifacts[0] ?? {}).llm).toMatchObject({ repaired: true });
  });

  it("falls back to deterministic generation when repair fails", async () => {
    const { generator } = createGenerator({
      responses: ["not json", "still not json"],
    });

    const result = await generator.generate(makeInput());

    expect(result.artifacts.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("LLMArtifactGenerator fell back to deterministic generation");
    expect(enhancement(result.artifacts[0] ?? {}).llm).toMatchObject({
      fallbackUsed: true,
    });
  });

  it("throws when fallback is disabled", async () => {
    const { generator } = createGenerator({
      responses: ["not json", "still not json"],
      allowFallbackToDeterministic: false,
    });

    await expect(generator.generate(makeInput())).rejects.toThrow();
  });

  it("requires confirmation for numeric enhancement without cited evidence", async () => {
    const { generator } = createGenerator({
      responses: [JSON.stringify(outputArtifact({
        content: "Improved executive reporting accuracy by 35%.",
        status: "needs_confirmation",
        supportLevel: "needs_user_confirmation",
        riskLevel: "medium",
        confirmationQuestions: ["Can you confirm 35% accuracy improvement?"],
        enhancementStrategy: "confirmation_needed",
      }))],
    });

    const result = await generator.generate(makeInput());

    expect(enhancement(result.artifacts[0] ?? {}).status).toBe("needs_confirmation");
  });
});
