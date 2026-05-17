import { describe, expect, it } from "vitest";
import { CopilotResponseBuilder } from "../src/copilot/CopilotResponseBuilder.js";
import type { GeneratedArtifact } from "../src/knowledge/types.js";
import type { ArtifactCritiqueItem } from "../src/application/critique/types.js";
import type { ProductVariant } from "../src/copilot/types.js";

function makeArtifact(overrides: Partial<GeneratedArtifact> = {}): GeneratedArtifact {
  return {
    id: "artifact-1",
    userId: "user-1",
    type: "resume_bullet",
    content: "Built React design systems and reduced bundle size by 40%.",
    sourceExperienceIds: ["exp-1"],
    sourceEvidenceIds: ["ev-1"],
    matchedSkillIds: ["skill-1"],
    targetJDId: "jd-1",
    targetRequirementIds: ["req-1"],
    targetRole: "Frontend Engineer",
    scores: { overall: 0.85, requirementMatch: 0.9, evidenceStrength: 0.8 },
    status: "ready",
    metadata: { enhancement: { status: "ready" } },
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeCritiqueItem(overrides: Partial<ArtifactCritiqueItem> = {}): ArtifactCritiqueItem {
  return {
    artifactId: "artifact-1",
    verdict: "pass",
    truthfulnessRisk: "low",
    exaggerationRisk: "low",
    specificityScore: 0.8,
    evidenceStrengthScore: 0.7,
    unsupportedClaims: [],
    missingEvidence: [],
    rewriteSuggestions: ["Add more quantification"],
    claimReviews: [
      { claimText: "Built React design systems", supportLevel: "supported", riskLevel: "low", verdict: "pass", reason: "Evidence found", evidenceIds: ["ev-1"] },
      { claimText: "reduced bundle size by 40%", supportLevel: "supported", riskLevel: "low", verdict: "pass", reason: "Evidence found", evidenceIds: ["ev-1"] },
    ],
    ...overrides,
  };
}

describe("CopilotResponseBuilder", () => {
  const builder = new CopilotResponseBuilder();

  describe("buildChatResponse", () => {
    it("returns a complete CopilotChatResponse with all sections", () => {
      const result = builder.buildChatResponse({
        sessionId: "s-1", turnId: "t-1", userMessage: "Generate resume content",
        generatedArtifacts: [makeArtifact()],
        critiqueItems: [makeCritiqueItem()],
        evidenceChains: [],
        targetRole: "Frontend Engineer",
      });

      expect(result.sessionId).toBe("s-1");
      expect(result.turnId).toBe("t-1");
      expect(result.assistantMessage.role).toBe("assistant");
      expect(result.timeline.length).toBeGreaterThan(0);
      expect(result.workspace.variants.length).toBe(1);
      expect(result.raw.artifactIds).toContain("artifact-1");
      expect(result.nextActions.map((action) => action.type)).toEqual([
        "accept",
        "show_evidence",
        "explain_choice",
        "revise_more_conservative",
      ]);
    });

    it("returns plain_text when no artifacts", () => {
      const result = builder.buildChatResponse({
        sessionId: "s-1", turnId: "t-1", userMessage: "Generate",
        targetRole: "Frontend Engineer",
      });
      expect(result.assistantMessage.kind).toBe("plain_text");
      expect(result.nextActions).toEqual([]);
    });

    it("uses confirm_metric as the primary top-level action when recommended variant needs confirmation", () => {
      const result = builder.buildChatResponse({
        sessionId: "s-1", turnId: "t-1", userMessage: "Generate",
        generatedArtifacts: [makeArtifact({ metadata: { enhancement: { status: "needs_confirmation" } } })],
        targetRole: "Frontend Engineer",
      });

      expect(result.nextActions.map((action) => action.type)).toEqual([
        "confirm_metric",
        "accept",
        "show_evidence",
        "explain_choice",
        "revise_more_conservative",
      ]);
      expect(result.nextActions.find((action) => action.type === "confirm_metric")?.primary).toBe(true);
      expect(result.nextActions.find((action) => action.type === "accept")?.primary).toBe(false);
    });
  });

  describe("buildVariant", () => {
    it("converts artifact + critique into ProductVariant with new fields", () => {
      const artifact = makeArtifact();
      const critique = makeCritiqueItem();
      const variant = builder.buildVariant({ artifact, critiqueItems: [critique], targetRole: "Frontend Engineer" });

      expect(variant.id).toBe("artifact-1");
      expect(variant.artifactId).toBe("artifact-1");
      expect(variant.title.length).toBeGreaterThan(0);
      expect(variant.content).toBe(artifact.content);
      expect(variant.after).toBe(artifact.content); // backward-compat
      expect(variant.role).toBeDefined();
      expect(variant.status).toBeDefined();
      expect(variant.score.overall).toBe(0.85);
      expect(variant.score.relevance).toBe(0.9);
      expect(variant.score.evidenceStrength).toBe(0.8);
      expect(variant.badges.length).toBeGreaterThan(0);
      expect(variant.reason.length).toBeGreaterThan(0);
      expect(variant.evidenceSummary.coverageLabel.length).toBeGreaterThan(0);
      expect(variant.riskSummary.level).toBe("low");
      expect(variant.missingInfo).toBeDefined();
      expect(variant.sourceExperienceIds).toEqual(["exp-1"]);
      expect(variant.sourceEvidenceIds).toEqual(["ev-1"]);
      expect(variant.actions.length).toBeGreaterThan(0);
      expect(variant.actions.some(a => a.primary)).toBe(true);
      expect(variant.raw).toBeDefined();
    });

    it("maps ready enhancement to ready status", () => {
      const v = builder.buildVariant({ artifact: makeArtifact({ metadata: { enhancement: { status: "ready" } } }) });
      expect(v.status).toBe("ready");
    });

    it("maps needs_confirmation enhancement to needs_confirmation status", () => {
      const v = builder.buildVariant({ artifact: makeArtifact({ metadata: { enhancement: { status: "needs_confirmation" } } }) });
      expect(v.status).toBe("needs_confirmation");
    });

    it("maps unsafe enhancement to unsafe status", () => {
      const v = builder.buildVariant({ artifact: makeArtifact({ metadata: { enhancement: { status: "unsafe" } } }) });
      expect(v.status).toBe("unsafe");
    });

    it("marks recommended variant as recommended role", () => {
      const a1 = makeArtifact({ id: "a1", scores: { overall: 0.9, requirementMatch: 0.9, evidenceStrength: 0.9 } });
      const a2 = makeArtifact({ id: "a2", scores: { overall: 0.6, requirementMatch: 0.6, evidenceStrength: 0.6 } });

      const result = builder.buildChatResponse({
        sessionId: "s-1", turnId: "t-1", userMessage: "test",
        generatedArtifacts: [a1, a2],
        targetRole: "FE",
      });

      const recommended = result.workspace.variants.find(v => v.role === "recommended");
      expect(recommended).toBeDefined();
      expect(recommended!.id).toBe("a1");
    });

    it("includes riskSummary with unsupported claims and missing evidence", () => {
      const artifact = makeArtifact();
      const critique = makeCritiqueItem({
        unsupportedClaims: ["Claim X lacks evidence"],
        missingEvidence: ["No source for metric Y"],
        truthfulnessRisk: "high",
      });
      const v = builder.buildVariant({ artifact, critiqueItems: [critique] });
      expect(v.riskSummary.unsupportedClaims).toContain("Claim X lacks evidence");
      expect(v.riskSummary.missingEvidence).toContain("No source for metric Y");
      expect(v.riskSummary.level).toBe("high");
    });
  });

  describe("buildClarifyingQuestion", () => {
    it("returns clarifying_question assistant message", () => {
      const result = builder.buildClarifyingQuestion("s-1", "t-1", "Could you provide more info?");
      expect(result.assistantMessage.kind).toBe("clarifying_question");
      expect(result.workspace.status).toBe("empty");
    });
  });

  describe("safety: no chain-of-thought leaks", () => {
    it("buildChatResponse raw contains only IDs", () => {
      const result = builder.buildChatResponse({
        sessionId: "s-1", turnId: "t-1", userMessage: "test",
        generatedArtifacts: [makeArtifact()],
        critiqueItems: [makeCritiqueItem()],
      });
      const json = JSON.stringify(result);
      expect(json).not.toContain("chain-of-thought");
      expect(json).not.toContain("reasoning_content");
      expect(json).not.toContain("internal_prompt");
      expect(json).not.toContain("tool_args");
    });

    it("buildVariant does not include raw model output", () => {
      const v = builder.buildVariant({ artifact: makeArtifact() });
      const json = JSON.stringify(v);
      expect(json).not.toContain("chain-of-thought");
      expect(json).not.toContain("reasoning_content");
    });
  });
});
