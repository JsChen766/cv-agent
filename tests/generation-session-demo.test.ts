import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addForcedSupplementalGapForDemo } from "../src/examples/utils/sessionDemoForcedGap.js";
import {
  GenerationSessionManager,
  InMemoryGenerationSessionRepository,
} from "../src/application/sessions/index.js";
import type { GenerateResumeResponse } from "../src/api-contracts/generation.js";
import type {
  ArtifactCritiqueReport,
} from "../src/application/critique/types.js";
import type { ArtifactCoverageReport } from "../src/application/evaluation/types.js";
import type { CoverageGapReport } from "../src/application/coverage-gaps/types.js";
import type {
  EvidenceChain,
  GeneratedArtifact,
  GraphView,
  JDRequirement,
} from "../src/knowledge/types.js";

const NOW = "2024-01-01T00:00:00Z";

function makeRequirement(): JDRequirement {
  return {
    id: "req-1",
    userId: "user-1",
    jdId: "jd-1",
    description: "React",
    requiredSkillIds: ["skill-react"],
    weight: 1,
    createdAt: NOW,
  };
}

function makeArtifact(): GeneratedArtifact {
  return {
    id: "artifact-1",
    userId: "user-1",
    type: "resume_bullet",
    content: "Led a React design system.",
    sourceExperienceIds: ["exp-1"],
    sourceEvidenceIds: ["ev-1"],
    matchedSkillIds: ["skill-react"],
    targetJDId: "jd-1",
    targetRequirementIds: ["req-1"],
    targetRole: "Frontend Engineer",
    scores: { overall: 0.8, requirementMatch: 0.8, evidenceStrength: 0.8 },
    status: "ready",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeChain(artifact: GeneratedArtifact): EvidenceChain {
  return {
    id: "chain-1",
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

function makeCoverageReport(requirement: JDRequirement): ArtifactCoverageReport {
  return {
    id: "coverage-1",
    userId: "user-1",
    jdId: "jd-1",
    totalRequirements: 1,
    coveredRequirementIds: ["req-1"],
    weaklyCoveredRequirementIds: [],
    evidenceAvailableButNotUsedRequirementIds: [],
    noEvidenceRequirementIds: [],
    notTargetedRequirementIds: [],
    items: [{
      requirement,
      status: "covered",
      coveredByArtifactIds: ["artifact-1"],
      supportingEvidenceIds: ["ev-1"],
      supportingSkillIds: ["skill-react"],
      reason: "Covered.",
      suggestions: [],
    }],
    summary: "1/1 requirements covered.",
    createdAt: NOW,
  };
}

function makeGeneration(): GenerateResumeResponse {
  const artifact = makeArtifact();
  const requirement = makeRequirement();
  const critiqueReport: ArtifactCritiqueReport = {
    id: "critique-1",
    userId: "user-1",
    jdId: "jd-1",
    items: [],
    summary: "Reviewed.",
    createdAt: NOW,
  };
  const coverageGapReport: CoverageGapReport = {
    id: "gap-1",
    userId: "user-1",
    jdId: "jd-1",
    items: [],
    supplementalArtifactCount: 0,
    evidenceRequestCount: 0,
    summary: "0 gaps.",
    createdAt: NOW,
  };
  const graphView: GraphView = { nodes: [], edges: [] };

  return {
    userId: "user-1",
    jdId: "jd-1",
    jdText: "React",
    targetRole: "Frontend Engineer",
    requirements: [requirement],
    retrievedExperiences: [],
    artifacts: [{ artifact, evidenceChain: makeChain(artifact), graphView }],
    coverageReport: makeCoverageReport(requirement),
    coverageGapReport,
    critiqueReport,
    createdAt: NOW,
  };
}

describe("generation session demos", () => {
  it("default generation-session demo does not inject forced gaps", () => {
    const source = readFileSync("src/examples/generation-session-demo.ts", "utf8");

    expect(source).not.toContain("addForcedSupplementalGapForDemo");
    expect(source).not.toContain("forcedGapAdded");
    expect(source).not.toContain("demoSupplementalGapAdded");
  });

  it("forced-gap helper can generate a supplemental draft", async () => {
    const generation = addForcedSupplementalGapForDemo(makeGeneration());
    const repo = new InMemoryGenerationSessionRepository();
    const manager = new GenerationSessionManager(repo);
    const session = await manager.createSession({ generation });
    const gap = generation.coverageGapReport.items[0];

    expect(gap?.gapType).toBe("missing_artifact");
    await manager.generateSupplementalArtifactDraft({
      sessionId: session.id,
      requirementId: gap?.requirement.id ?? "",
    });
    const updated = await manager.getSession(session.id);

    expect(updated?.supplementalArtifactDrafts).toHaveLength(1);
    expect(updated?.supplementalArtifactDrafts[0]?.artifact.scores.overall).toBe(0.75);
  });
});
