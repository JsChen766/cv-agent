import { describe, expect, it } from "vitest";
import {
  LLMExperienceExtractionParseError,
  parseLLMExperienceExtraction,
} from "../src/knowledge/index.js";

const validOutput = {
  experiences: [{
    type: "work",
    organization: "Acme Corp",
    role: "Frontend Engineer",
    summary: "Built a React dashboard.",
    evidences: [{
      excerpt: "Built a React dashboard for internal analytics.",
      confidence: 0.9,
      skillNames: ["React"],
    }],
    skills: [{ name: "React", category: "technical" }],
  }],
  warnings: [],
};

describe("LLMExperienceExtractionParser", () => {
  it("parses raw JSON", () => {
    expect(parseLLMExperienceExtraction(JSON.stringify(validOutput))).toEqual(validOutput);
  });

  it("parses fenced JSON", () => {
    expect(parseLLMExperienceExtraction([
      "```json",
      JSON.stringify(validOutput),
      "```",
    ].join("\n"))).toEqual(validOutput);
  });

  it("throws for invalid JSON", () => {
    expect(() => parseLLMExperienceExtraction("{ invalid"))
      .toThrow(LLMExperienceExtractionParseError);
  });

  it("throws for schema-invalid JSON", () => {
    expect(() => parseLLMExperienceExtraction(JSON.stringify({
      experiences: [],
      warnings: [],
    }))).toThrow(LLMExperienceExtractionParseError);
  });
});
