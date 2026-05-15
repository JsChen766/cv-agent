import { describe, expect, it } from "vitest";
import { LLMArtifactCritic } from "../src/application/critique/LLMArtifactCritic.js";
import { ModelClient } from "../src/core/model/ModelClient.js";
import type { LLMProvider } from "../src/core/model/LLMProvider.js";
import type { LLMChatRequest, LLMChatResponse } from "../src/core/model/types.js";
import type { ArtifactCoverageReport } from "../src/application/evaluation/types.js";
import type {
  Evidence,
  EvidenceChain,
  Experience,
  GeneratedArtifact,
  JDRequirement,
} from "../src/knowledge/types.js";

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

function createCritic(input: {
  responses: string[];
  allowJsonRepair?: boolean;
  allowFallbackToDeterministic?: boolean;
}): {
  critic: LLMArtifactCritic;
  provider: SequenceProvider;
} {
  const provider = new SequenceProvider(input.responses);
  return {
    provider,
    critic: new LLMArtifactCritic({
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

const NOW = "2024-01-01T00:00:00Z";

function makeArtifact(id: string, content: string): GeneratedArtifact {
  return {
    id,
    userId: "user-1",
    type: "resume_bullet",
    content,
    sourceExperienceIds: ["exp-1"],
    sourceEvidenceIds: ["ev-1"],
    matchedSkillIds: ["skill-1"],
    targetJDId: "jd-1",
    targetRequirementIds: ["req-1"],
    targetRole: "Analyst",
    scores: { overall: 0.8, requirementMatch: 0.8, evidenceStrength: 0.8 },
    status: "ready",
    metadata: {
      enhancement: {
        status: id === "artifact-revise" ? "needs_confirmation" : id === "artifact-reject" ? "unsafe" : "ready",
        claims: [{
          text: content,
          supportLevel: id === "artifact-revise"
            ? "needs_user_confirmation"
            : id === "artifact-reject"
              ? "unsupported"
              : "supported",
          riskLevel: id === "artifact-pass" ? "low" : "high",
          evidenceIds: id === "artifact-pass" ? ["ev-1"] : [],
          sourceExperienceIds: ["exp-1"],
        }],
        confirmationQuestions: id === "artifact-revise" ? ["Confirm metric."] : [],
        enhancementStrategy: id === "artifact-pass" ? "evidence_rewrite" : "confirmation_needed",
      },
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeInput() {
  const artifacts = [
    makeArtifact("artifact-pass", "Built dashboards with cited evidence."),
    makeArtifact("artifact-revise", "Improved reporting by 30%."),
    makeArtifact("artifact-reject", "Owned company-wide analytics strategy."),
  ];
  const experience: Experience = {
    id: "exp-1",
    userId: "user-1",
    type: "work",
    organization: "Acme",
    role: "Analyst",
    summary: "Built dashboards.",
    timeRange: { startDate: null, endDate: null },
    star: { situation: "s", task: "t", action: "a", result: "r" },
    evidenceIds: ["ev-1"],
    skillIds: ["skill-1"],
    confidence: 0.9,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const evidence: Evidence = {
    id: "ev-1",
    userId: "user-1",
    experienceId: "exp-1",
    sourceType: "raw_input",
    evidenceType: "project",
    sourceRef: "test",
    excerpt: "Built dashboards with cited evidence.",
    confidence: 0.9,
    createdAt: NOW,
  };
  const chains: EvidenceChain[] = artifacts.map((artifact) => ({
    id: `chain-${artifact.id}`,
    artifact,
    summary: "chain summary",
    requirementMatches: [],
    sourceExperiences: [experience],
    sourceEvidences: [evidence],
    sourceSkills: [],
    risk: {
      level: artifact.id === "artifact-pass" ? "low" : artifact.id === "artifact-revise" ? "medium" : "high",
      truthfulnessRisk: artifact.id === "artifact-pass" ? "low" : "high",
      exaggerationRisk: artifact.id === "artifact-pass" ? "low" : "high",
      missingEvidenceClaims: artifact.id === "artifact-revise" ? ["Confirm metric."] : [],
      exaggerationWarnings: artifact.id === "artifact-reject" ? ["Unsupported scope."] : [],
      notes: [],
    },
    scores: artifact.scores,
    createdAt: NOW,
  }));
  const requirement: JDRequirement = {
    id: "req-1",
    userId: "user-1",
    jdId: "jd-1",
    description: "Dashboard work",
    requiredSkillIds: [],
    weight: 1,
    createdAt: NOW,
  };
  const coverageReport: ArtifactCoverageReport = {
    id: "coverage-1",
    userId: "user-1",
    jdId: "jd-1",
    totalRequirements: 1,
    coveredRequirementIds: ["req-1"],
    weaklyCoveredRequirementIds: [],
    evidenceAvailableButNotUsedRequirementIds: [],
    noEvidenceRequirementIds: [],
    notTargetedRequirementIds: [],
    items: [{
      requirement,
      status: "covered",
      coveredByArtifactIds: ["artifact-pass"],
      supportingEvidenceIds: ["ev-1"],
      supportingSkillIds: [],
      reason: "Covered.",
      suggestions: [],
    }],
    summary: "Covered.",
    createdAt: NOW,
  };
  return {
    userId: "user-1",
    jdId: "jd-1",
    artifacts,
    evidenceChains: chains,
    coverageReport,
  };
}

function validOutput() {
  return {
    items: [
      {
        artifactId: "artifact-pass",
        verdict: "pass",
        truthfulnessRisk: "low",
        exaggerationRisk: "low",
        specificityScore: 0.8,
        evidenceStrengthScore: 0.8,
        unsupportedClaims: [],
        missingEvidence: [],
        rewriteSuggestions: [],
        confirmationQuestions: [],
        safeRewriteSuggestion: "Built dashboards with cited evidence.",
        claimReviews: [{
          claimText: "Built dashboards with cited evidence.",
          supportLevel: "supported",
          riskLevel: "low",
          verdict: "pass",
          reason: "Supported by ev-1.",
          evidenceIds: ["ev-1"],
        }],
      },
      {
        artifactId: "artifact-revise",
        verdict: "revise",
        truthfulnessRisk: "medium",
        exaggerationRisk: "medium",
        specificityScore: 0.7,
        evidenceStrengthScore: 0.5,
        unsupportedClaims: [],
        missingEvidence: ["Confirm 30% improvement."],
        rewriteSuggestions: ["Use non-quantified wording until confirmed."],
        confirmationQuestions: ["Confirm 30% improvement."],
        safeRewriteSuggestion: "Built reporting workflows using cited dashboard evidence.",
        claimReviews: [{
          claimText: "Improved reporting by 30%.",
          supportLevel: "needs_user_confirmation",
          riskLevel: "medium",
          verdict: "revise",
          reason: "Metric is not cited.",
          evidenceIds: [],
        }],
      },
      {
        artifactId: "artifact-reject",
        verdict: "reject",
        truthfulnessRisk: "high",
        exaggerationRisk: "high",
        specificityScore: 0.4,
        evidenceStrengthScore: 0.2,
        unsupportedClaims: ["Owned company-wide analytics strategy."],
        missingEvidence: ["No evidence for company-wide strategy."],
        rewriteSuggestions: ["Remove company-wide strategy claim."],
        confirmationQuestions: [],
        safeRewriteSuggestion: "Built dashboards using cited evidence.",
        claimReviews: [{
          claimText: "Owned company-wide analytics strategy.",
          supportLevel: "unsupported",
          riskLevel: "high",
          verdict: "reject",
          reason: "No evidence supports ownership scope.",
          evidenceIds: [],
        }],
      },
    ],
    summary: "One pass, one revise, one reject.",
    warnings: [],
  };
}

describe("LLMArtifactCritic", () => {
  it("maps valid LLM output into ArtifactCritiqueReport", async () => {
    const { critic, provider } = createCritic({
      responses: [JSON.stringify(validOutput())],
    });

    const report = await critic.critique(makeInput());

    expect(report.items.map((item) => item.verdict)).toEqual(["pass", "revise", "reject"]);
    expect(report.items[1]?.confirmationQuestions).toEqual(["Confirm 30% improvement."]);
    expect(report.items[1]?.rewriteSuggestions).toContain("Use non-quantified wording until confirmed.");
    expect(report.items[1]?.safeRewriteSuggestion).toContain("cited dashboard evidence");
    expect(report.items[2]?.unsupportedClaims).toContain("Owned company-wide analytics strategy.");
    expect(report.items[2]?.claimReviews?.[0]).toMatchObject({
      supportLevel: "unsupported",
      verdict: "reject",
    });
    expect(report.metadata?.llm).toMatchObject({
      provider: "sequence",
      repaired: false,
      fallbackUsed: false,
    });
    expect(provider.requests[0]?.responseFormat).toBe("json");
    expect(provider.requests[0]?.temperature).toBe(0);
  });

  it("repairs invalid JSON once", async () => {
    const { critic, provider } = createCritic({
      responses: ["not json", JSON.stringify(validOutput())],
    });

    const report = await critic.critique(makeInput());

    expect(report.items).toHaveLength(3);
    expect(provider.requests).toHaveLength(2);
    expect(report.metadata?.llm).toMatchObject({ repaired: true });
  });

  it("falls back to deterministic critique when repair fails", async () => {
    const { critic } = createCritic({
      responses: ["not json", "still not json"],
    });

    const report = await critic.critique(makeInput());

    expect(report.items).toHaveLength(3);
    expect(report.metadata?.critic).toBe("DeterministicArtifactCritic");
    expect(report.metadata?.llm).toMatchObject({ fallbackUsed: true });
  });

  it("throws when fallback is disabled", async () => {
    const { critic } = createCritic({
      responses: ["not json", "still not json"],
      allowFallbackToDeterministic: false,
    });

    await expect(critic.critique(makeInput())).rejects.toThrow();
  });
});
