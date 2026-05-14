import { describe, expect, it } from "vitest";
import { CriticAgent } from "../src/agents/CriticAgent.js";
import { AgentArtifactCritic } from "../src/application/critique/AgentArtifactCritic.js";
import type { ArtifactCoverageReport } from "../src/application/evaluation/types.js";
import { ModelClient } from "../src/core/model/ModelClient.js";
import type { LLMProvider } from "../src/core/model/LLMProvider.js";
import type { LLMChatRequest, LLMChatResponse } from "../src/core/model/types.js";
import type { EvidenceChain, GeneratedArtifact, JDRequirement } from "../src/knowledge/types.js";

const NOW = "2024-01-01T00:00:00Z";
const USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function fakeProvider(response: string): LLMProvider {
  return {
    name: "fake",
    async chat(_request: LLMChatRequest): Promise<LLMChatResponse> {
      return { content: response, usage: USAGE };
    },
  };
}

function makeCritic(response: string): AgentArtifactCritic {
  return new AgentArtifactCritic(new CriticAgent({
    modelClient: new ModelClient({ provider: fakeProvider(response), defaultModel: "fake" }),
  }));
}

function makeArtifact(): GeneratedArtifact {
  return {
    id: "artifact-1",
    userId: "user-1",
    type: "resume_bullet",
    content: "Reduced bundle size by 40%.",
    sourceExperienceIds: ["exp-1"],
    sourceEvidenceIds: ["ev-1"],
    matchedSkillIds: ["skill-performance"],
    targetJDId: "jd-1",
    targetRequirementIds: ["req-1"],
    targetRole: "Engineer",
    scores: { overall: 0.7, requirementMatch: 0.7, evidenceStrength: 0.85 },
    status: "ready",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeChain(artifact: GeneratedArtifact): EvidenceChain {
  return {
    id: "chain-1",
    artifact,
    summary: "Backed by evidence.",
    requirementMatches: [],
    sourceExperiences: [],
    sourceEvidences: [],
    sourceSkills: [],
    risk: {
      level: "low",
      truthfulnessRisk: "low",
      exaggerationRisk: "low",
      missingEvidenceClaims: [],
      exaggerationWarnings: [],
      notes: [],
    },
    scores: artifact.scores,
    createdAt: NOW,
  };
}

function makeCoverageReport(): ArtifactCoverageReport {
  const requirement: JDRequirement = {
    id: "req-1",
    userId: "user-1",
    jdId: "jd-1",
    description: "Performance",
    requiredSkillIds: [],
    weight: 1,
    createdAt: NOW,
  };
  return {
    id: "coverage-1",
    jdId: "jd-1",
    userId: "user-1",
    totalRequirements: 1,
    coveredRequirementIds: ["req-1"],
    weaklyCoveredRequirementIds: [],
    evidenceAvailableButNotUsedRequirementIds: [],
    noEvidenceRequirementIds: [],
    notTargetedRequirementIds: [],
    items: [
      {
        requirement,
        status: "covered",
        coveredByArtifactIds: ["artifact-1"],
        supportingEvidenceIds: ["ev-1"],
        supportingSkillIds: [],
        reason: "Covered.",
        suggestions: [],
      },
    ],
    summary: "1/1 requirements covered.",
    createdAt: NOW,
  };
}

function validOutput() {
  return {
    items: [
      {
        artifactId: "artifact-1",
        verdict: "pass",
        truthfulnessRisk: "low",
        exaggerationRisk: "low",
        specificityScore: 0.8,
        evidenceStrengthScore: 0.85,
        unsupportedClaims: [],
        missingEvidence: [],
        rewriteSuggestions: [],
      },
    ],
    summary: "1 artifact reviewed.",
  };
}

async function critiqueWith(response: string) {
  const artifact = makeArtifact();
  return makeCritic(response).critique({
    userId: "user-1",
    jdId: "jd-1",
    artifacts: [artifact],
    evidenceChains: [makeChain(artifact)],
    coverageReport: makeCoverageReport(),
  });
}

describe("AgentArtifactCritic", () => {
  it("parses valid JSON agent output", async () => {
    const report = await critiqueWith(JSON.stringify(validOutput()));

    expect(report.items[0]?.artifactId).toBe("artifact-1");
    expect(report.summary).toBe("1 artifact reviewed.");
  });

  it("parses markdown code fence JSON agent output", async () => {
    const report = await critiqueWith(`\`\`\`json\n${JSON.stringify(validOutput())}\n\`\`\``);

    expect(report.items[0]?.verdict).toBe("pass");
  });

  it("throws on invalid JSON", async () => {
    await expect(critiqueWith("not json")).rejects.toThrow("not valid JSON");
  });

  it("throws on schema errors", async () => {
    await expect(
      critiqueWith(JSON.stringify({ items: [{ artifactId: "artifact-1" }], summary: "bad" })),
    ).rejects.toThrow("AgentArtifactCritic");
  });
});
