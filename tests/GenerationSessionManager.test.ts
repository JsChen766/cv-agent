import { describe, expect, it } from "vitest";
import {
  GenerationSessionManager,
  InMemoryGenerationSessionRepository,
} from "../src/application/sessions/index.js";
import type { GenerationSession } from "../src/application/sessions/types.js";
import type { GenerateResumeResponse } from "../src/api-contracts/generation.js";
import type { ArtifactCoverageReport } from "../src/application/evaluation/types.js";
import type { CoverageGapReport } from "../src/application/coverage-gaps/types.js";
import type {
  ArtifactCritiqueReport,
} from "../src/application/critique/types.js";
import type {
  EvidenceChain,
  GeneratedArtifact,
  GraphView,
  JDRequirement,
} from "../src/knowledge/types.js";

const NOW = "2024-01-01T00:00:00Z";

function makeRequirement(params: Partial<JDRequirement> = {}): JDRequirement {
  return {
    id: "req-api",
    userId: "user-1",
    jdId: "jd-1",
    description: "API Integration",
    requiredSkillIds: ["skill-api"],
    weight: 1,
    createdAt: NOW,
    ...params,
  };
}

function makeArtifact(params: Partial<GeneratedArtifact> = {}): GeneratedArtifact {
  return {
    id: "artifact-1",
    userId: "user-1",
    type: "resume_bullet",
    content: "Built API integrations.",
    sourceExperienceIds: ["exp-1"],
    sourceEvidenceIds: ["ev-api"],
    matchedSkillIds: ["skill-api"],
    targetJDId: "jd-1",
    targetRequirementIds: ["req-api"],
    targetRole: "Frontend Engineer",
    scores: { overall: 0.8, requirementMatch: 0.8, evidenceStrength: 0.8 },
    status: "ready",
    createdAt: NOW,
    updatedAt: NOW,
    ...params,
  };
}

function makeChain(artifact: GeneratedArtifact): EvidenceChain {
  return {
    id: `chain-${artifact.id}`,
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

function makeGraphView(): GraphView {
  return { nodes: [], edges: [] };
}

function makeCoverageReport(requirements: JDRequirement[]): ArtifactCoverageReport {
  return {
    id: "coverage-1",
    userId: "user-1",
    jdId: "jd-1",
    totalRequirements: requirements.length,
    coveredRequirementIds: ["req-covered"],
    weaklyCoveredRequirementIds: [],
    evidenceAvailableButNotUsedRequirementIds: ["req-api"],
    noEvidenceRequirementIds: ["req-collab"],
    notTargetedRequirementIds: [],
    items: requirements.map((requirement) => ({
      requirement,
      status: requirement.id === "req-covered"
        ? "covered"
        : requirement.id === "req-api"
          ? "evidence_available_but_not_used"
          : "no_evidence",
      coveredByArtifactIds: requirement.id === "req-covered" ? ["artifact-1"] : [],
      supportingEvidenceIds: requirement.id === "req-api" ? ["ev-api"] : [],
      supportingSkillIds: requirement.id === "req-api" ? ["skill-api"] : [],
      reason: "Coverage reason.",
      suggestions: [],
    })),
    summary: "Coverage summary.",
    createdAt: NOW,
  };
}

function makeCoverageGapReport(apiReq: JDRequirement, collabReq: JDRequirement): CoverageGapReport {
  return {
    id: "gap-report-1",
    userId: "user-1",
    jdId: "jd-1",
    items: [
      {
        requirement: apiReq,
        gapType: "missing_artifact",
        severity: "medium",
        existingEvidenceIds: ["ev-api"],
        existingArtifactIds: [],
        supplementalArtifactSuggestions: [{
          type: "resume_bullet",
          content: "Applied API integration patterns from existing frontend evidence.",
          sourceExperienceIds: ["exp-1"],
          sourceEvidenceIds: ["ev-api"],
          matchedSkillIds: ["skill-api"],
          targetRequirementIds: ["req-api"],
          confidence: 0.75,
          riskLevel: "low",
          rationale: "Evidence exists but no artifact targets it.",
        }],
        evidenceRequestSuggestions: [],
        reason: "API evidence exists but no artifact targets it.",
      },
      {
        requirement: collabReq,
        gapType: "missing_evidence",
        severity: "high",
        existingEvidenceIds: [],
        existingArtifactIds: [],
        supplementalArtifactSuggestions: [],
        evidenceRequestSuggestions: [{
          prompt: "Please add collaboration evidence.",
          expectedEvidenceType: "collaboration",
          reason: "No evidence.",
        }],
        reason: "No collaboration evidence.",
      },
    ],
    supplementalArtifactCount: 1,
    evidenceRequestCount: 1,
    summary: "2 gaps.",
    createdAt: NOW,
  };
}

function makeCritiqueReport(): ArtifactCritiqueReport {
  return {
    id: "critique-1",
    userId: "user-1",
    jdId: "jd-1",
    items: [],
    summary: "Reviewed.",
    createdAt: NOW,
  };
}

function makeGeneration(): GenerateResumeResponse {
  const artifact1 = makeArtifact({ id: "artifact-1" });
  const artifact2 = makeArtifact({ id: "artifact-2", content: "Reduced bundle size." });
  const apiReq = makeRequirement();
  const collabReq = makeRequirement({
    id: "req-collab",
    description: "Cross-team collaboration",
    requiredSkillIds: [],
  });
  const coveredReq = makeRequirement({
    id: "req-covered",
    description: "React experience",
    requiredSkillIds: [],
  });
  const requirements = [coveredReq, apiReq, collabReq];

  return {
    userId: "user-1",
    jdId: "jd-1",
    jdText: "Need React, API integration, and collaboration.",
    targetRole: "Frontend Engineer",
    requirements,
    retrievedExperiences: [],
    artifacts: [
      { artifact: artifact1, evidenceChain: makeChain(artifact1), graphView: makeGraphView() },
      { artifact: artifact2, evidenceChain: makeChain(artifact2), graphView: makeGraphView() },
    ],
    coverageReport: makeCoverageReport(requirements),
    coverageGapReport: makeCoverageGapReport(apiReq, collabReq),
    critiqueReport: makeCritiqueReport(),
    createdAt: NOW,
  };
}

async function createManagerWithSession() {
  const repo = new InMemoryGenerationSessionRepository();
  const manager = new GenerationSessionManager(repo);
  const session = await manager.createSession({ generation: makeGeneration() });
  return { repo, manager, session };
}

function makeSessionForSort(id: string, updatedAt: string): GenerationSession {
  return {
    id,
    userId: "user-1",
    jdId: "jd-1",
    generation: makeGeneration(),
    artifactDecisions: [],
    coverageGapDecisions: [],
    supplementalArtifactDrafts: [],
    status: "active",
    createdAt: updatedAt,
    updatedAt,
  };
}

describe("GenerationSessionManager", () => {
  it("creates sessions with undecided artifact and coverage gap decisions", async () => {
    const { session } = await createManagerWithSession();

    expect(session.artifactDecisions).toHaveLength(2);
    expect(session.artifactDecisions.every((item) => item.decision === "undecided")).toBe(true);
    expect(session.artifactDecisions.every((item) =>
      item.artifactId.length > 0 &&
      item.decision.length > 0 &&
      item.decidedAt.length > 0,
    )).toBe(true);
    expect(JSON.parse(JSON.stringify(session.artifactDecisions))).toEqual(session.artifactDecisions);
    expect(session.coverageGapDecisions).toHaveLength(2);
    expect(session.coverageGapDecisions.every((item) => item.decision === "undecided")).toBe(true);
    expect(session.supplementalArtifactDrafts).toHaveLength(0);
  });

  it("marks an artifact as accepted without mutating artifact status", async () => {
    const { manager, session } = await createManagerWithSession();
    const updated = await manager.decideArtifact({
      sessionId: session.id,
      artifactId: "artifact-1",
      decision: "accepted",
      note: "Use this.",
    });

    expect(updated.artifactDecisions.find((item) => item.artifactId === "artifact-1")?.decision).toBe("accepted");
    expect(updated.artifactDecisions.find((item) => item.artifactId === "artifact-1")?.note).toBe("Use this.");
    expect(Array.isArray(updated.artifactDecisions)).toBe(true);
    expect(JSON.parse(JSON.stringify(updated.artifactDecisions))).toEqual(updated.artifactDecisions);
    expect(updated.generation.artifacts[0]?.artifact.status).toBe("ready");
  });

  it("throws when deciding an unknown artifact", async () => {
    const { manager, session } = await createManagerWithSession();

    await expect(
      manager.decideArtifact({
        sessionId: session.id,
        artifactId: "artifact-missing",
        decision: "accepted",
      }),
    ).rejects.toThrow(/artifact-missing/);
  });

  it("marks a coverage gap as requesting more evidence", async () => {
    const { manager, session } = await createManagerWithSession();
    const updated = await manager.decideCoverageGap({
      sessionId: session.id,
      requirementId: "req-collab",
      decision: "request_more_evidence",
    });

    expect(updated.coverageGapDecisions.find((item) => item.requirementId === "req-collab")?.decision).toBe("request_more_evidence");
  });

  it("throws when deciding an unknown coverage gap", async () => {
    const { manager, session } = await createManagerWithSession();

    await expect(
      manager.decideCoverageGap({
        sessionId: session.id,
        requirementId: "req-missing",
        decision: "ignore",
      }),
    ).rejects.toThrow(/req-missing/);
  });

  it("generates a supplemental artifact draft from a suggestion", async () => {
    const { manager, session } = await createManagerWithSession();
    const updated = await manager.generateSupplementalArtifactDraft({
      sessionId: session.id,
      requirementId: "req-api",
    });

    expect(updated.supplementalArtifactDrafts).toHaveLength(1);
    expect(updated.supplementalArtifactDrafts[0]?.artifact.content).toContain("API integration");
    expect(updated.supplementalArtifactDrafts[0]?.artifact.sourceEvidenceIds).toEqual(["ev-api"]);
    expect(updated.supplementalArtifactDrafts[0]?.artifact.status).toBe("ready");
    expect(updated.supplementalArtifactDrafts[0]?.artifact.scores).toEqual({
      overall: 0.75,
      requirementMatch: 0.75,
      evidenceStrength: 0.75,
    });
    expect(updated.generation.artifacts).toHaveLength(2);
    expect(updated.coverageGapDecisions.find((item) => item.requirementId === "req-api")?.decision).toBe("generate_supplemental_artifact");
  });

  it("does not duplicate supplemental drafts for the same requirement", async () => {
    const { manager, session } = await createManagerWithSession();

    await manager.generateSupplementalArtifactDraft({
      sessionId: session.id,
      requirementId: "req-api",
    });
    const updated = await manager.generateSupplementalArtifactDraft({
      sessionId: session.id,
      requirementId: "req-api",
    });

    expect(updated.supplementalArtifactDrafts).toHaveLength(1);
  });

  it("throws when a gap has no supplemental artifact suggestion", async () => {
    const { manager, session } = await createManagerWithSession();

    await expect(
      manager.generateSupplementalArtifactDraft({
        sessionId: session.id,
        requirementId: "req-collab",
      }),
    ).rejects.toThrow(/no supplemental artifact suggestion/);
  });

  it("rejects undecided artifact decisions at runtime", async () => {
    const { manager, session } = await createManagerWithSession();

    await expect(
      manager.decideArtifact({
        sessionId: session.id,
        artifactId: "artifact-1",
        decision: "undecided",
      } as unknown as Parameters<typeof manager.decideArtifact>[0]),
    ).rejects.toThrow();
  });

  it("rejects undecided coverage gap decisions at runtime", async () => {
    const { manager, session } = await createManagerWithSession();

    await expect(
      manager.decideCoverageGap({
        sessionId: session.id,
        requirementId: "req-api",
        decision: "undecided",
      } as unknown as Parameters<typeof manager.decideCoverageGap>[0]),
    ).rejects.toThrow();
  });

  it("rejects empty session and target ids at runtime", async () => {
    const { manager, session } = await createManagerWithSession();

    await expect(
      manager.decideArtifact({
        sessionId: "",
        artifactId: "artifact-1",
        decision: "accepted",
      }),
    ).rejects.toThrow();
    await expect(
      manager.decideArtifact({
        sessionId: session.id,
        artifactId: "",
        decision: "accepted",
      }),
    ).rejects.toThrow();
    await expect(
      manager.generateSupplementalArtifactDraft({
        sessionId: session.id,
        requirementId: "",
      }),
    ).rejects.toThrow();
  });

  it("summarizes artifact and coverage gap decisions", async () => {
    const { manager, session } = await createManagerWithSession();
    await manager.decideArtifact({
      sessionId: session.id,
      artifactId: "artifact-1",
      decision: "accepted",
    });
    await manager.decideArtifact({
      sessionId: session.id,
      artifactId: "artifact-2",
      decision: "needs_revision",
    });
    await manager.decideCoverageGap({
      sessionId: session.id,
      requirementId: "req-collab",
      decision: "request_more_evidence",
    });
    await manager.generateSupplementalArtifactDraft({
      sessionId: session.id,
      requirementId: "req-api",
    });

    const summary = await manager.getSummary(session.id);

    expect(summary.acceptedArtifacts).toBe(1);
    expect(summary.rejectedArtifacts).toBe(0);
    expect(summary.needsRevisionArtifacts).toBe(1);
    expect(summary.undecidedArtifacts).toBe(0);
    expect(summary.supplementalArtifactRequests).toBe(1);
    expect(summary.moreEvidenceRequests).toBe(1);
    expect(summary.ignoredGaps).toBe(0);
    expect(summary.notRelevantGaps).toBe(0);
    expect(summary.undecidedGaps).toBe(0);
    expect(summary.supplementalDraftCount).toBe(1);
  });

  it("lists sessions by user id in updatedAt descending order", async () => {
    const repo = new InMemoryGenerationSessionRepository();
    await repo.save(makeSessionForSort("session-older", "2024-01-01T00:00:00Z"));
    await repo.save(makeSessionForSort("session-newer", "2024-01-02T00:00:00Z"));

    const sessions = await repo.listByUserId("user-1");

    expect(sessions[0]?.id).toBe("session-newer");
    expect(sessions[1]?.id).toBe("session-older");
  });
});
