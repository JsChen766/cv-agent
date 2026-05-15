import { describe, expect, it } from "vitest";
import { DeterministicArtifactRevisionAgent } from "../src/application/revision/index.js";
import type {
  ArtifactCritiqueItem,
} from "../src/application/critique/types.js";
import type { Evidence, EvidenceChain, Experience, GeneratedArtifact } from "../src/knowledge/types.js";

const NOW = "2024-01-01T00:00:00.000Z";

describe("DeterministicArtifactRevisionAgent", () => {
  it("uses safeRewriteSuggestion when removing unsupported claims", async () => {
    const artifact = makeArtifact();
    const critiqueItem = makeCritique({
      safeRewriteSuggestion: "Built reporting dashboards from cited requirements.",
    });
    const result = await new DeterministicArtifactRevisionAgent().revise({
      userId: "user-1",
      artifact,
      critiqueItem,
      evidenceChain: makeChain(artifact),
      instruction: "remove_unsupported_claims",
    });

    expect(result.revisedArtifact.content).toBe("Built reporting dashboards from cited requirements.");
    expect(result.revisedArtifact.sourceEvidenceIds).toEqual(["ev-1"]);
    expect(result.revisedArtifact.metadata?.enhancement).toMatchObject({
      status: "ready",
      enhancementStrategy: "evidence_rewrite",
    });
  });

  it("uses source evidence excerpt for conservative revisions", async () => {
    const artifact = makeArtifact({ content: "Improved reporting accuracy by 35%." });
    const result = await new DeterministicArtifactRevisionAgent().revise({
      userId: "user-1",
      artifact,
      evidenceChain: makeChain(artifact, "Built reporting dashboards."),
      instruction: "make_more_conservative",
    });

    expect(result.revisedArtifact.content).toBe("Built reporting dashboards.");
    expect(result.revisedArtifact.metadata?.revision).toMatchObject({
      revisedFromArtifactId: artifact.id,
      instruction: "make_more_conservative",
      deterministic: true,
    });
  });

  it("marks quantified revisions as needs_confirmation when no number exists", async () => {
    const artifact = makeArtifact({ content: "Built reporting dashboards." });
    const result = await new DeterministicArtifactRevisionAgent().revise({
      userId: "user-1",
      artifact,
      evidenceChain: makeChain(artifact, "Built reporting dashboards."),
      instruction: "make_more_quantified",
    });

    expect(result.revisedArtifact.status).toBe("needs_review");
    expect(result.revisedArtifact.metadata?.enhancement).toMatchObject({
      status: "needs_confirmation",
      enhancementStrategy: "confirmation_needed",
    });
    expect(readEnhancement(result.revisedArtifact).confirmationQuestions.length).toBeGreaterThan(0);
  });

  it("records user confirmations on apply_user_confirmation", async () => {
    const artifact = makeArtifact({ content: "Reduced reporting time by 35%." });
    const result = await new DeterministicArtifactRevisionAgent().revise({
      userId: "user-1",
      artifact,
      evidenceChain: makeChain(artifact, "Built reporting dashboards."),
      instruction: "apply_user_confirmation",
      userConfirmations: [{
        metric: "reporting time",
        value: "35%",
        explanation: "Measured from weekly reporting preparation.",
      }],
    });

    expect(result.revisedArtifact.metadata?.revision).toMatchObject({
      userConfirmations: [{
        metric: "reporting time",
        value: "35%",
      }],
    });
    expect(readEnhancement(result.revisedArtifact).claims[0]?.supportLevel).toBe("inferred");
  });

  it("preserves evidence ids and complete enhancement metadata", async () => {
    const artifact = makeArtifact();
    const result = await new DeterministicArtifactRevisionAgent().revise({
      userId: "user-1",
      artifact,
      evidenceChain: makeChain(artifact),
      instruction: "rewrite_for_tone",
      tone: "concise",
    });
    const enhancement = readEnhancement(result.revisedArtifact);

    expect(result.revisedArtifact.sourceEvidenceIds).toEqual(["ev-1"]);
    expect(enhancement.claims[0]).toMatchObject({
      text: result.revisedArtifact.content,
      supportLevel: "supported",
      riskLevel: "low",
      evidenceIds: ["ev-1"],
      sourceExperienceIds: ["exp-1"],
    });
    expect(enhancement.confirmationQuestions).toEqual([]);
  });
});

function makeArtifact(params: Partial<GeneratedArtifact> = {}): GeneratedArtifact {
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
    scores: {
      overall: 0.7,
      requirementMatch: 0.7,
      evidenceStrength: 0.8,
    },
    status: "ready",
    metadata: {
      enhancement: {
        status: "ready",
        claims: [{
          text: "Built reporting dashboards.",
          supportLevel: "supported",
          riskLevel: "low",
          evidenceIds: ["ev-1"],
          sourceExperienceIds: ["exp-1"],
        }],
        confirmationQuestions: [],
        enhancementStrategy: "evidence_rewrite",
      },
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...params,
  };
}

function makeCritique(params: Partial<ArtifactCritiqueItem> = {}): ArtifactCritiqueItem {
  return {
    artifactId: "artifact-1",
    verdict: "revise",
    truthfulnessRisk: "medium",
    exaggerationRisk: "medium",
    specificityScore: 0.7,
    evidenceStrengthScore: 0.5,
    unsupportedClaims: [],
    missingEvidence: [],
    rewriteSuggestions: [],
    ...params,
  };
}

function makeChain(artifact: GeneratedArtifact, excerpt = "Built reporting dashboards."): EvidenceChain {
  const experience: Experience = {
    id: "exp-1",
    userId: "user-1",
    type: "project",
    organization: "Acme",
    role: "BI Analyst",
    summary: excerpt,
    timeRange: { startDate: null, endDate: null },
    star: { situation: excerpt, task: excerpt, action: excerpt, result: excerpt },
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
    excerpt,
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

function readEnhancement(artifact: GeneratedArtifact): {
  claims: Array<{ supportLevel?: string; riskLevel?: string; evidenceIds?: string[]; sourceExperienceIds?: string[]; text?: string }>;
  confirmationQuestions: string[];
} {
  const enhancement = artifact.metadata?.enhancement;
  if (typeof enhancement !== "object" || enhancement === null || Array.isArray(enhancement)) {
    return { claims: [], confirmationQuestions: [] };
  }
  const record = enhancement as Record<string, unknown>;
  return {
    claims: Array.isArray(record.claims)
      ? record.claims as Array<{ supportLevel?: string; riskLevel?: string; evidenceIds?: string[]; sourceExperienceIds?: string[]; text?: string }>
      : [],
    confirmationQuestions: Array.isArray(record.confirmationQuestions)
      ? record.confirmationQuestions.filter((item): item is string => typeof item === "string")
      : [],
  };
}
