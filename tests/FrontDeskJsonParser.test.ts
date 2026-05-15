import { describe, expect, it } from "vitest";
import {
  FrontDeskDecisionParseError,
  parseFrontDeskDecision,
} from "../src/agents/frontdesk/index.js";

const validDecision = {
  intent: "generate_resume_for_jd",
  confidence: 0.87,
  summary: "Generate resume content for a job description.",
  requiredActions: [{
    type: "generate_resume",
    target: "ResumeGenerationService",
    arguments: {
      targetRole: "Frontend Engineer",
    },
  }],
};

describe("FrontDeskJsonParser", () => {
  it("parses raw JSON", () => {
    expect(parseFrontDeskDecision(JSON.stringify(validDecision))).toEqual(validDecision);
  });

  it("parses fenced JSON", () => {
    expect(parseFrontDeskDecision([
      "```json",
      JSON.stringify(validDecision),
      "```",
    ].join("\n"))).toEqual(validDecision);
  });

  it("parses JSON with prefix and suffix text", () => {
    expect(parseFrontDeskDecision(
      `Here is the JSON: ${JSON.stringify(validDecision)} Done.`,
    )).toEqual(validDecision);
  });

  it("throws for invalid JSON", () => {
    expect(() => parseFrontDeskDecision("{ invalid"))
      .toThrow(FrontDeskDecisionParseError);
  });

  it("throws for schema-invalid JSON", () => {
    expect(() => parseFrontDeskDecision(JSON.stringify({
      ...validDecision,
      intent: "bad_intent",
    }))).toThrow(FrontDeskDecisionParseError);
  });

  it("handles nested braces in action arguments", () => {
    const decision = {
      ...validDecision,
      requiredActions: [{
        type: "generate_resume",
        target: "ResumeGenerationService",
        arguments: {
          payload: {
            jdText: "Need {React} and TypeScript.",
          },
        },
      }],
    };

    expect(parseFrontDeskDecision(`prefix ${JSON.stringify(decision)} suffix`)).toEqual(decision);
  });
});
