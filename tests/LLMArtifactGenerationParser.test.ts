import { describe, expect, it } from "vitest";
import {
  LLMArtifactGenerationParseError,
  parseLLMArtifactGeneration,
} from "../src/application/generators/LLMArtifactGenerationParser.js";
import type { Evidence } from "../src/knowledge/types.js";
import type { LLMArtifactGenerationOutput } from "../src/application/generators/LLMArtifactGenerationSchema.js";

const evidences: Evidence[] = [
  {
    id: "ev-1",
    userId: "user-1",
    experienceId: "exp-1",
    sourceType: "raw_input",
    evidenceType: "result",
    sourceRef: "test",
    excerpt: "Reduced report preparation time from 2 hours to 20 minutes.",
    confidence: 0.9,
    createdAt: "2024-01-01T00:00:00Z",
  },
];

const context = {
  evidences,
  experienceIds: ["exp-1"],
  requirementIds: ["req-1"],
};

function validOutput(): LLMArtifactGenerationOutput {
  return {
    artifacts: [{
      content: "Reduced report preparation time from 2 hours to 20 minutes.",
      targetRequirementIds: ["req-1"],
      sourceExperienceIds: ["exp-1"],
      sourceEvidenceIds: ["ev-1"],
      claims: [{
        text: "Reduced report preparation time from 2 hours to 20 minutes.",
        supportLevel: "supported",
        riskLevel: "low",
        evidenceIds: ["ev-1"],
        sourceExperienceIds: ["exp-1"],
      }],
      status: "ready",
      confirmationQuestions: [],
      enhancementStrategy: "evidence_rewrite",
    }],
    warnings: [],
  };
}

describe("LLMArtifactGenerationParser", () => {
  it("parses raw JSON valid output", () => {
    expect(parseLLMArtifactGeneration(JSON.stringify(validOutput()), context)).toEqual(validOutput());
  });

  it("parses fenced JSON valid output", () => {
    expect(parseLLMArtifactGeneration([
      "```json",
      JSON.stringify(validOutput()),
      "```",
    ].join("\n"), context)).toEqual(validOutput());
  });

  it("throws for schema invalid output", () => {
    expect(() => parseLLMArtifactGeneration(JSON.stringify({
      artifacts: [],
      warnings: [],
    }), context)).toThrow(LLMArtifactGenerationParseError);
  });

  it("fails ready artifacts with unsupported claims", () => {
    const output = validOutput();
    output.artifacts[0].claims[0].supportLevel = "unsupported";
    expect(() => parseLLMArtifactGeneration(JSON.stringify(output), context))
      .toThrow(LLMArtifactGenerationParseError);
  });

  it("fails artifacts with empty sourceEvidenceIds", () => {
    const output = validOutput();
    output.artifacts[0].sourceEvidenceIds = [];
    expect(() => parseLLMArtifactGeneration(JSON.stringify(output), context))
      .toThrow(LLMArtifactGenerationParseError);
  });

  it("requires confirmation or unsupported claim for new numeric tokens", () => {
    const output = validOutput();
    output.artifacts[0].content = "Reduced report preparation time by 80%.";
    output.artifacts[0].claims[0].text = "Reduced report preparation time by 80%.";
    expect(() => parseLLMArtifactGeneration(JSON.stringify(output), context))
      .toThrow(LLMArtifactGenerationParseError);

    output.artifacts[0].status = "needs_confirmation";
    output.artifacts[0].claims[0].supportLevel = "needs_user_confirmation";
    output.artifacts[0].claims[0].riskLevel = "medium";
    output.artifacts[0].confirmationQuestions = ["Can you confirm the 80% reduction?"];
    expect(parseLLMArtifactGeneration(JSON.stringify(output), context).artifacts[0]?.status)
      .toBe("needs_confirmation");
  });
});
