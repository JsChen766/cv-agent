import { describe, expect, it } from "vitest";
import {
  parseLLMArtifactRevision,
} from "../src/application/revision/index.js";
import type { ArtifactRevisionInput } from "../src/application/revision/index.js";
import type { Evidence, EvidenceChain, Experience, GeneratedArtifact } from "../src/knowledge/types.js";

const NOW = "2024-01-01T00:00:00.000Z";

describe("LLMArtifactRevisionParser", () => {
  it("parses valid raw JSON", () => {
    const result = parseLLMArtifactRevision(JSON.stringify(validOutput()), makeInput());

    expect(result.content).toBe("Built reporting dashboards.");
    expect(result.status).toBe("ready");
  });

  it("parses fenced JSON", () => {
    const result = parseLLMArtifactRevision(
      `\`\`\`json\n${JSON.stringify(validOutput())}\n\`\`\``,
      makeInput(),
    );

    expect(result.sourceEvidenceIds).toEqual(["ev-1"]);
  });

  it("rejects ready revisions with unsupported claims", () => {
    expect(() => parseLLMArtifactRevision(JSON.stringify(validOutput({
      claims: [{
        text: "Unsupported.",
        supportLevel: "unsupported",
        riskLevel: "high",
        evidenceIds: [],
        sourceExperienceIds: [],
      }],
    })), makeInput())).toThrow(/ready revision must not include unsupported/);
  });

  it("rejects ready revisions with needs_user_confirmation claims", () => {
    expect(() => parseLLMArtifactRevision(JSON.stringify(validOutput({
      claims: [{
        text: "Needs confirmation.",
        supportLevel: "needs_user_confirmation",
        riskLevel: "medium",
        evidenceIds: [],
        sourceExperienceIds: [],
      }],
    })), makeInput())).toThrow(/ready revision must not include needs_user_confirmation/);
  });

  it("rejects supported claim evidence outside sourceEvidenceIds", () => {
    expect(() => parseLLMArtifactRevision(JSON.stringify(validOutput({
      claims: [{
        text: "Built reporting dashboards.",
        supportLevel: "supported",
        riskLevel: "low",
        evidenceIds: ["ev-2"],
        sourceExperienceIds: ["exp-1"],
      }],
    })), makeInput())).toThrow(/subset of sourceEvidenceIds/);
  });

  it("rejects unknown evidence ids", () => {
    expect(() => parseLLMArtifactRevision(JSON.stringify(validOutput({
      sourceEvidenceIds: ["ev-unknown"],
    })), makeInput())).toThrow(/unknown evidence id/);
  });

  it("rejects unsupported numbers without confirmation metadata", () => {
    expect(() => parseLLMArtifactRevision(JSON.stringify(validOutput({
      content: "Improved reporting accuracy by 35%.",
    })), makeInput())).toThrow(/numeric claim/);
  });

  it("allows unsupported numbers when marked needs_confirmation", () => {
    const result = parseLLMArtifactRevision(JSON.stringify(validOutput({
      content: "Improved reporting accuracy by 35%.",
      status: "needs_confirmation",
      claims: [{
        text: "Improved reporting accuracy by 35%.",
        supportLevel: "needs_user_confirmation",
        riskLevel: "medium",
        evidenceIds: [],
        sourceExperienceIds: ["exp-1"],
        userConfirmationPrompt: "Confirm 35%.",
      }],
      confirmationQuestions: ["Confirm 35%."],
      enhancementStrategy: "confirmation_needed",
    })), makeInput());

    expect(result.status).toBe("needs_confirmation");
  });

  it("rejects remove_unsupported_claims output that still contains unsupported claims", () => {
    expect(() => parseLLMArtifactRevision(JSON.stringify(validOutput({
      status: "needs_confirmation",
      claims: [{
        text: "Still unsupported.",
        supportLevel: "unsupported",
        riskLevel: "high",
        evidenceIds: [],
        sourceExperienceIds: [],
      }],
    })), makeInput({ instruction: "remove_unsupported_claims" }))).toThrow(/must not contain unsupported/);
  });
});

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
    content: "Built reporting dashboards.",
    sourceExperienceIds: ["exp-1"],
    sourceEvidenceIds: ["ev-1"],
    matchedSkillIds: [],
    targetJDId: "jd-1",
    targetRequirementIds: ["req-1"],
    targetRole: "BI Analyst",
    scores: { overall: 0.7, requirementMatch: 0.7, evidenceStrength: 0.8 },
    status: "ready",
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
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
    createdAt: NOW,
    updatedAt: NOW,
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
    createdAt: NOW,
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
