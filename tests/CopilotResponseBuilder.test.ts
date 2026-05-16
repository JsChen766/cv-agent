import { describe, expect, it } from "vitest";
import { CopilotResponseBuilder } from "../src/copilot/CopilotResponseBuilder.js";
import type { GeneratedArtifact } from "../src/knowledge/types.js";
import type { ArtifactCritiqueItem } from "../src/application/critique/types.js";

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
    scores: {
      overall: 0.85,
      requirementMatch: 0.9,
      evidenceStrength: 0.8,
    },
    status: "ready",
    metadata: {
      enhancement: { status: "ready" },
    },
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
      {
        claimText: "Built React design systems",
        supportLevel: "supported",
        riskLevel: "low",
        verdict: "pass",
        reason: "Evidence found",
        evidenceIds: ["ev-1"],
      },
      {
        claimText: "reduced bundle size by 40%",
        supportLevel: "supported",
        riskLevel: "low",
        verdict: "pass",
        reason: "Evidence found",
        evidenceIds: ["ev-1"],
      },
    ],
    ...overrides,
  };
}

describe("CopilotResponseBuilder", () => {
  const builder = new CopilotResponseBuilder();

  describe("buildChatResponse", () => {
    it("returns a complete CopilotChatResponse with all sections", () => {
      const artifact = makeArtifact();
      const critique = makeCritiqueItem();

      const result = builder.buildChatResponse({
        sessionId: "s-1",
        turnId: "t-1",
        userMessage: "Generate resume content",
        generatedArtifacts: [artifact],
        critiqueItems: [critique],
        evidenceChains: [],
        targetRole: "Frontend Engineer",
        clientState: {},
      });

      expect(result.sessionId).toBe("s-1");
      expect(result.turnId).toBe("t-1");
      expect(result.assistantMessage.role).toBe("assistant");
      expect(result.assistantMessage.kind).toBe("variant_suggestion");
      expect(result.timeline.length).toBeGreaterThan(0);
      expect(result.workspace.variants.length).toBe(1);
      expect(result.nextActions.length).toBeGreaterThan(0);
      expect(result.raw.artifactIds).toContain("artifact-1");
    });

    it("returns variant_suggestion kind when artifacts exist", () => {
      const artifact = makeArtifact();
      const result = builder.buildChatResponse({
        sessionId: "s-1",
        turnId: "t-1",
        userMessage: "Generate",
        generatedArtifacts: [artifact],
        targetRole: "Frontend Engineer",
      });

      expect(result.assistantMessage.kind).toBe("variant_suggestion");
    });

    it("returns plain_text kind when no artifacts are generated", () => {
      const result = builder.buildChatResponse({
        sessionId: "s-1",
        turnId: "t-1",
        userMessage: "Generate",
        targetRole: "Frontend Engineer",
      });

      expect(result.assistantMessage.kind).toBe("plain_text");
    });
  });

  describe("buildVariant", () => {
    it("converts artifact + critique + evidence into ProductVariant", () => {
      const artifact = makeArtifact();
      const critique = makeCritiqueItem();

      const variant = builder.buildVariant({
        artifact,
        critiqueItems: [critique],
        evidenceChains: [],
        targetRole: "Frontend Engineer",
      });

      expect(variant.id).toBe("artifact-1");
      expect(variant.artifactId).toBe("artifact-1");
      expect(variant.title.length).toBeGreaterThan(0);
      expect(variant.after).toBe(artifact.content);
      expect(variant.badges.length).toBeGreaterThan(0);
      expect(variant.decisionState).toBe("undecided");
      expect(variant.score?.overall).toBe(0.85);
      expect(variant.score?.relevance).toBe(0.9);
      expect(variant.score?.evidenceStrength).toBe(0.8);
    });

    it("adds 'Needs confirmation' badge for needs_confirmation status", () => {
      const artifact = makeArtifact({
        metadata: { enhancement: { status: "needs_confirmation" } },
      });
      const variant = builder.buildVariant({ artifact });

      expect(variant.badges.some((b) => b.label === "Needs confirmation")).toBe(true);
    });

    it("adds 'Unsafe' badge for unsafe status", () => {
      const artifact = makeArtifact({
        metadata: { enhancement: { status: "unsafe" } },
      });
      const variant = builder.buildVariant({ artifact });

      expect(variant.badges.some((b) => b.label === "Unsafe")).toBe(true);
    });

    it("adds critique verdict badge", () => {
      const artifact = makeArtifact();
      const critique = makeCritiqueItem({ verdict: "revise" });
      const variant = builder.buildVariant({
        artifact,
        critiqueItems: [critique],
      });

      expect(variant.badges.some((b) => b.label === "Critique: revise")).toBe(true);
    });

    it("includes critiqueSummary strengths and risks", () => {
      const artifact = makeArtifact();
      const critique = makeCritiqueItem({
        rewriteSuggestions: ["Use active voice", "Quantify results"],
        unsupportedClaims: ["Claim lacks evidence"],
        missingEvidence: ["No source for metric"],
      });
      const variant = builder.buildVariant({
        artifact,
        critiqueItems: [critique],
      });

      expect(variant.critiqueSummary).toBeDefined();
      expect(variant.critiqueSummary!.strengths).toContain("Use active voice");
      expect(variant.critiqueSummary!.risks.length).toBeGreaterThan(0);
      expect(variant.critiqueSummary!.suggestions).toContain("Quantify results");
    });
  });

  describe("buildNextActions", () => {
    it("returns accept/reject/prefer/revise/evidence actions for each variant", () => {
      const artifact = makeArtifact();
      const variant = builder.buildVariant({ artifact });

      const actions = builder.buildNextActions({
        variants: [variant],
        workspaceStatus: "ready",
      });

      const types = actions.map((a) => a.type);
      expect(types).toContain("accept");
      expect(types).toContain("reject");
      expect(types).toContain("prefer");
      expect(types).toContain("revise_more_conservative");
      expect(types).toContain("revise_more_quantified");
      expect(types).toContain("show_evidence");
      expect(types).toContain("explain_choice");
    });

    it("adds confirm_metric action when awaiting_user_decision", () => {
      const artifact = makeArtifact();
      const variant = builder.buildVariant({ artifact });

      const actions = builder.buildNextActions({
        variants: [variant],
        workspaceStatus: "awaiting_user_decision",
      });

      const types = actions.map((a) => a.type);
      expect(types).toContain("confirm_metric");
    });
  });

  describe("buildClarifyingQuestion", () => {
    it("returns clarifying_question assistant message", () => {
      const result = builder.buildClarifyingQuestion("s-1", "t-1", "Could you provide more info?");
      expect(result.assistantMessage.kind).toBe("clarifying_question");
      expect(result.assistantMessage.content).toBe("Could you provide more info?");
      expect(result.workspace.status).toBe("empty");
      expect(result.workspace.variants).toEqual([]);
    });
  });

  describe("safety: no chain-of-thought leaks", () => {
    it("buildChatResponse raw section contains only IDs, no reasoning", () => {
      const result = builder.buildChatResponse({
        sessionId: "s-1",
        turnId: "t-1",
        userMessage: "test",
        generatedArtifacts: [makeArtifact()],
        critiqueItems: [makeCritiqueItem()],
      });

      // raw should only have arrays of IDs, no content
      const json = JSON.stringify(result);
      expect(json).not.toContain("chain-of-thought");
      expect(json).not.toContain("reasoning_content");
      expect(json).not.toContain("internal_prompt");
      expect(json).not.toContain("tool_args");
      expect(json).not.toContain("system_prompt");
    });

    it("buildVariant does not include raw model output", () => {
      const variant = builder.buildVariant({ artifact: makeArtifact() });
      const json = JSON.stringify(variant);
      expect(json).not.toContain("chain-of-thought");
      expect(json).not.toContain("reasoning_content");
    });
  });
});
