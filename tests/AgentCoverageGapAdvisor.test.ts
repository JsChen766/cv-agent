import { describe, expect, it } from "vitest";
import { CriticAgent } from "../src/agents/CriticAgent.js";
import { AgentCoverageGapAdvisor } from "../src/application/coverage-gaps/AgentCoverageGapAdvisor.js";
import type { ArtifactCoverageReport } from "../src/application/evaluation/types.js";
import { ModelClient } from "../src/core/model/ModelClient.js";
import type { LLMProvider } from "../src/core/model/LLMProvider.js";
import type { LLMChatRequest, LLMChatResponse } from "../src/core/model/types.js";
import type { RetrievedExperience } from "../src/knowledge/retrieval/ExperienceRetriever.js";
import type {
  Evidence,
  Experience,
  GeneratedArtifact,
  JDRequirement,
  Skill,
} from "../src/knowledge/types.js";

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

function makeAdvisor(response: string): AgentCoverageGapAdvisor {
  return new AgentCoverageGapAdvisor(new CriticAgent({
    modelClient: new ModelClient({ provider: fakeProvider(response), defaultModel: "fake" }),
  }));
}

function makeRequirement(): JDRequirement {
  return {
    id: "req-api",
    userId: "user-1",
    jdId: "jd-1",
    description: "API Integration",
    requiredSkillIds: ["skill-api"],
    weight: 1,
    createdAt: NOW,
  };
}

function makeEvidence(): Evidence {
  return {
    id: "ev-api",
    userId: "user-1",
    experienceId: "exp-1",
    sourceType: "raw_input",
    evidenceType: "skill_proof",
    sourceRef: "test",
    excerpt: "Built shared API integration patterns.",
    confidence: 0.9,
    createdAt: NOW,
  };
}

function makeSkill(): Skill {
  return {
    id: "skill-api",
    userId: "user-1",
    name: "API Integration",
    category: "technical",
    evidenceIds: ["ev-api"],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeExperience(): Experience {
  return {
    id: "exp-1",
    userId: "user-1",
    type: "work",
    organization: "Acme",
    role: "Engineer",
    summary: "Built APIs.",
    timeRange: { startDate: null, endDate: null },
    star: { situation: "x", task: "x", action: "x", result: "x" },
    evidenceIds: ["ev-api"],
    skillIds: ["skill-api"],
    confidence: 0.8,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeArtifact(): GeneratedArtifact {
  return {
    id: "artifact-1",
    userId: "user-1",
    type: "resume_bullet",
    content: "Built frontend systems.",
    sourceExperienceIds: [],
    sourceEvidenceIds: [],
    matchedSkillIds: [],
    targetJDId: "jd-1",
    targetRequirementIds: [],
    targetRole: "Engineer",
    scores: { overall: 0.5, requirementMatch: 0.5, evidenceStrength: 0.5 },
    status: "needs_review",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeRetrieved(): RetrievedExperience {
  const evidence = makeEvidence();
  const skill = makeSkill();
  return {
    experience: makeExperience(),
    evidences: [evidence],
    skills: [skill],
    matchedEvidences: [evidence],
    matchedSkills: [skill],
    matchedRequirements: [],
    matchScore: 0.8,
    matchedRequirementIds: [],
    matchedEvidenceIds: ["ev-api"],
    matchedSkillIds: ["skill-api"],
    reason: "Matched.",
  };
}

function makeCoverageReport(): ArtifactCoverageReport {
  const requirement = makeRequirement();
  return {
    id: "coverage-1",
    jdId: "jd-1",
    userId: "user-1",
    totalRequirements: 1,
    coveredRequirementIds: [],
    weaklyCoveredRequirementIds: [],
    evidenceAvailableButNotUsedRequirementIds: ["req-api"],
    noEvidenceRequirementIds: [],
    notTargetedRequirementIds: [],
    items: [{
      requirement,
      status: "evidence_available_but_not_used",
      coveredByArtifactIds: [],
      supportingEvidenceIds: ["ev-api"],
      supportingSkillIds: ["skill-api"],
      reason: "Evidence exists.",
      suggestions: [],
    }],
    summary: "0/1 requirements covered.",
    createdAt: NOW,
  };
}

function validOutput() {
  return {
    items: [{
      requirementId: "req-api",
      gapType: "missing_artifact",
      severity: "medium",
      existingEvidenceIds: ["ev-api"],
      existingArtifactIds: [],
      supplementalArtifactSuggestions: [{
        type: "resume_bullet",
        content: "Applied API integration patterns.",
        sourceExperienceIds: ["exp-1"],
        sourceEvidenceIds: ["ev-api"],
        matchedSkillIds: ["skill-api"],
        targetRequirementIds: ["req-api"],
        confidence: 0.75,
        riskLevel: "low",
        rationale: "Evidence exists but no artifact targets it.",
      }],
      evidenceRequestSuggestions: [],
      reason: "Missing artifact.",
    }],
    supplementalArtifactCount: 1,
    evidenceRequestCount: 0,
    summary: "1 gap identified.",
  };
}

async function adviseWith(response: string) {
  return makeAdvisor(response).advise({
    userId: "user-1",
    jdId: "jd-1",
    coverageReport: makeCoverageReport(),
    retrievedExperiences: [makeRetrieved()],
    artifacts: [makeArtifact()],
  });
}

describe("AgentCoverageGapAdvisor", () => {
  it("parses valid JSON agent output", async () => {
    const report = await adviseWith(JSON.stringify(validOutput()));

    expect(report.items[0]?.requirement.id).toBe("req-api");
    expect(report.items[0]?.gapType).toBe("missing_artifact");
    expect(report.summary).toBe("1 gap identified.");
  });

  it("parses markdown code fence JSON agent output", async () => {
    const report = await adviseWith(`\`\`\`json\n${JSON.stringify(validOutput())}\n\`\`\``);

    expect(report.supplementalArtifactCount).toBe(1);
  });

  it("throws on invalid JSON", async () => {
    await expect(adviseWith("not json")).rejects.toThrow("not valid JSON");
  });

  it("throws on schema errors", async () => {
    await expect(
      adviseWith(JSON.stringify({ items: [{ requirementId: "req-api" }], summary: "bad" })),
    ).rejects.toThrow("AgentCoverageGapAdvisor");
  });
});
