import { describe, expect, it } from "vitest";
import { LLMArtifactRevisionAgent } from "../src/application/revision/index.js";
import { ModelClient } from "../src/core/model/ModelClient.js";
import type { LLMProvider } from "../src/core/model/LLMProvider.js";
import type { LLMChatRequest, LLMChatResponse } from "../src/core/model/types.js";
import type { ArtifactRevisionInput } from "../src/application/revision/index.js";
import type { Evidence, EvidenceChain, Experience, GeneratedArtifact } from "../src/knowledge/types.js";

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

describe("LLMArtifactRevisionAgent", () => {
  it("maps valid LLM revision output to a revised artifact", async () => {
    const { agent, provider } = createAgent([JSON.stringify(validOutput())]);

    const result = await agent.revise(makeInput());

    expect(result.revisedArtifact.content).toBe("Built reporting dashboards.");
    expect(result.revisedArtifact.sourceEvidenceIds).toEqual(["ev-1"]);
    expect(result.revisedArtifact.metadata?.revision).toMatchObject({
      revisedFromArtifactId: "artifact-1",
      instruction: "make_more_conservative",
      llm: {
        provider: "sequence",
        repaired: false,
        fallbackUsed: false,
      },
    });
    expect(result.revisedArtifact.metadata?.enhancement).toMatchObject({
      status: "ready",
      enhancementStrategy: "evidence_rewrite",
    });
    expect(provider.requests[0]?.responseFormat).toBe("json");
    expect(provider.requests[0]?.temperature).toBe(0.2);
  });

  it("repairs invalid JSON once", async () => {
    const { agent } = createAgent(["not json", JSON.stringify(validOutput({
      content: "Built reporting dashboards for finance stakeholders.",
    }))]);

    const result = await agent.revise(makeInput());

    expect(result.revisedArtifact.content).toBe("Built reporting dashboards for finance stakeholders.");
    expect(result.revisedArtifact.metadata?.revision).toMatchObject({
      llm: {
        repaired: true,
        fallbackUsed: false,
      },
    });
  });

  it("falls back to deterministic revision after repair failure", async () => {
    const { agent } = createAgent(["not json", "still not json"]);

    const result = await agent.revise(makeInput());

    expect(result.revisedArtifact.metadata?.revision).toMatchObject({
      deterministic: true,
      llm: {
        provider: "sequence",
        repaired: true,
        fallbackUsed: true,
      },
    });
    expect(result.warnings[0]).toContain("fell back");
  });

  it("throws when fallback is disabled", async () => {
    const { agent } = createAgent(["not json", "still not json"], {
      allowFallbackToDeterministic: false,
    });

    await expect(agent.revise(makeInput())).rejects.toThrow(/not valid JSON|schema|post-validation/);
  });

  it("records user confirmations in revision metadata", async () => {
    const { agent } = createAgent([JSON.stringify(validOutput({
      content: "Reduced report preparation time by 35%.",
      claims: [{
        text: "Reduced report preparation time by 35%.",
        supportLevel: "inferred",
        riskLevel: "low",
        evidenceIds: ["ev-1"],
        sourceExperienceIds: ["exp-1"],
      }],
    }))]);

    const result = await agent.revise(makeInput({
      instruction: "apply_user_confirmation",
      userConfirmations: [{ metric: "report preparation time", value: "35%" }],
    }));

    expect(result.revisedArtifact.metadata?.revision).toMatchObject({
      instruction: "apply_user_confirmation",
      userConfirmations: [{ metric: "report preparation time", value: "35%" }],
    });
  });
});

function createAgent(
  responses: string[],
  options: { allowFallbackToDeterministic?: boolean } = {},
): { agent: LLMArtifactRevisionAgent; provider: SequenceProvider } {
  const provider = new SequenceProvider(responses);
  return {
    provider,
    agent: new LLMArtifactRevisionAgent({
      modelClient: new ModelClient({
        provider,
        defaultModel: "fake",
        maxRetries: 0,
      }),
      allowFallbackToDeterministic: options.allowFallbackToDeterministic,
    }),
  };
}

function validOutput(params: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    content: "Built reporting dashboards.",
    sourceExperienceIds: ["exp-1"],
    sourceEvidenceIds: ["ev-1"],
    targetRequirementIds: ["req-1"],
    claims: [{
      text: "Built reporting dashboards.",
      supportLevel: "supported",
      riskLevel: "low",
      evidenceIds: ["ev-1"],
      sourceExperienceIds: ["exp-1"],
    }],
    status: "ready",
    confirmationQuestions: [],
    enhancementStrategy: "evidence_rewrite",
    warnings: [],
    ...params,
  };
}

function makeInput(params: Partial<ArtifactRevisionInput> = {}): ArtifactRevisionInput {
  const artifact = makeArtifact();
  return {
    userId: "user-1",
    artifact,
    evidenceChain: makeChain(artifact),
    instruction: "make_more_conservative",
    ...params,
  };
}

function makeArtifact(): GeneratedArtifact {
  return {
    id: "artifact-1",
    userId: "user-1",
    type: "resume_bullet",
    content: "Improved reporting accuracy by 35%.",
    sourceExperienceIds: ["exp-1"],
    sourceEvidenceIds: ["ev-1"],
    matchedSkillIds: [],
    targetJDId: "jd-1",
    targetRequirementIds: ["req-1"],
    targetRole: "BI Analyst",
    scores: { overall: 0.6, requirementMatch: 0.6, evidenceStrength: 0.5 },
    status: "needs_review",
    metadata: {},
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

function makeChain(artifact: GeneratedArtifact): EvidenceChain {
  const experience: Experience = {
    id: "exp-1",
    userId: "user-1",
    type: "project",
    organization: "Acme",
    role: "BI Analyst",
    summary: "Built reporting dashboards.",
    timeRange: { startDate: null, endDate: null },
    star: {
      situation: "Reporting needed dashboards.",
      task: "Build dashboards.",
      action: "Built reporting dashboards.",
      result: "Dashboards delivered.",
    },
    evidenceIds: ["ev-1"],
    skillIds: [],
    confidence: 0.9,
    metadata: {},
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
  const evidence: Evidence = {
    id: "ev-1",
    userId: "user-1",
    experienceId: "exp-1",
    sourceType: "manual",
    evidenceType: "project",
    sourceRef: "test",
    excerpt: "Built reporting dashboards.",
    confidence: 0.9,
    metadata: {},
    createdAt: "2024-01-01T00:00:00.000Z",
  };
  return {
    id: "chain-1",
    artifact,
    summary: "summary",
    requirementMatches: [],
    sourceExperiences: [experience],
    sourceEvidences: [evidence],
    sourceSkills: [],
    risk: {
      level: "medium",
      truthfulnessRisk: "medium",
      exaggerationRisk: "medium",
      missingEvidenceClaims: ["35% is not confirmed."],
      exaggerationWarnings: [],
      notes: [],
    },
    scores: artifact.scores,
    createdAt: "2024-01-01T00:00:00.000Z",
  };
}
