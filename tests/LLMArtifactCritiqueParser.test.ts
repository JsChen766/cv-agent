import { describe, expect, it } from "vitest";
import {
  LLMArtifactCritiqueParseError,
  parseLLMArtifactCritique,
} from "../src/application/critique/LLMArtifactCritiqueParser.js";
import type { LLMArtifactCritiqueOutput } from "../src/application/critique/LLMArtifactCritiqueSchema.js";
import type { GeneratedArtifact } from "../src/knowledge/types.js";

const artifacts: GeneratedArtifact[] = [
  makeArtifact("artifact-1"),
  makeArtifact("artifact-2"),
];

function makeArtifact(id: string): GeneratedArtifact {
  return {
    id,
    userId: "user-1",
    type: "resume_bullet",
    content: "Built dashboards.",
    sourceExperienceIds: ["exp-1"],
    sourceEvidenceIds: ["ev-1"],
    matchedSkillIds: [],
    targetJDId: "jd-1",
    targetRequirementIds: ["req-1"],
    targetRole: "Analyst",
    scores: { overall: 0.8, requirementMatch: 0.8, evidenceStrength: 0.8 },
    status: "ready",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}

function validOutput(): LLMArtifactCritiqueOutput {
  return {
    items: [
      {
        artifactId: "artifact-1",
        verdict: "pass",
        truthfulnessRisk: "low",
        exaggerationRisk: "low",
        specificityScore: 0.8,
        evidenceStrengthScore: 0.8,
        unsupportedClaims: [],
        missingEvidence: [],
        rewriteSuggestions: [],
        confirmationQuestions: [],
        claimReviews: [{
          claimText: "Built dashboards.",
          supportLevel: "supported",
          riskLevel: "low",
          verdict: "pass",
          reason: "Supported.",
          evidenceIds: ["ev-1"],
        }],
      },
      {
        artifactId: "artifact-2",
        verdict: "revise",
        truthfulnessRisk: "medium",
        exaggerationRisk: "medium",
        specificityScore: 0.6,
        evidenceStrengthScore: 0.5,
        unsupportedClaims: [],
        missingEvidence: ["Confirm metric."],
        rewriteSuggestions: ["Remove unconfirmed metric."],
        confirmationQuestions: ["Confirm metric."],
        claimReviews: [{
          claimText: "Improved by 30%.",
          supportLevel: "needs_user_confirmation",
          riskLevel: "medium",
          verdict: "revise",
          reason: "Needs confirmation.",
          evidenceIds: [],
        }],
      },
    ],
    summary: "Reviewed 2 artifacts.",
    warnings: [],
  };
}

describe("LLMArtifactCritiqueParser", () => {
  it("parses valid raw JSON", () => {
    expect(parseLLMArtifactCritique(JSON.stringify(validOutput()), artifacts)).toEqual(validOutput());
  });

  it("parses fenced JSON", () => {
    expect(parseLLMArtifactCritique([
      "```json",
      JSON.stringify(validOutput()),
      "```",
    ].join("\n"), artifacts)).toEqual(validOutput());
  });

  it("throws for schema invalid output", () => {
    expect(() => parseLLMArtifactCritique(JSON.stringify({
      items: [],
      summary: "",
    }), artifacts)).toThrow(LLMArtifactCritiqueParseError);
  });

  it("throws for pass item with unsupported claims", () => {
    const output = validOutput();
    output.items[0].unsupportedClaims = ["Unsupported."];
    expect(() => parseLLMArtifactCritique(JSON.stringify(output), artifacts))
      .toThrow(LLMArtifactCritiqueParseError);
  });

  it("throws for pass item with unsupported claimReview", () => {
    const output = validOutput();
    output.items[0].claimReviews[0].supportLevel = "unsupported";
    expect(() => parseLLMArtifactCritique(JSON.stringify(output), artifacts))
      .toThrow(LLMArtifactCritiqueParseError);
  });

  it("throws for pass item with needs_user_confirmation claimReview", () => {
    const output = validOutput();
    output.items[0].claimReviews[0].supportLevel = "needs_user_confirmation";
    expect(() => parseLLMArtifactCritique(JSON.stringify(output), artifacts))
      .toThrow(LLMArtifactCritiqueParseError);
  });

  it("throws for duplicate artifactId", () => {
    const output = validOutput();
    output.items[1].artifactId = "artifact-1";
    expect(() => parseLLMArtifactCritique(JSON.stringify(output), artifacts))
      .toThrow(LLMArtifactCritiqueParseError);
  });

  it("throws for missing artifact item", () => {
    const output = validOutput();
    output.items = output.items.slice(0, 1);
    expect(() => parseLLMArtifactCritique(JSON.stringify(output), artifacts))
      .toThrow(LLMArtifactCritiqueParseError);
  });

  it("throws for unknown artifactId", () => {
    const output = validOutput();
    output.items[1].artifactId = "artifact-missing";
    expect(() => parseLLMArtifactCritique(JSON.stringify(output), artifacts))
      .toThrow(LLMArtifactCritiqueParseError);
  });
});
