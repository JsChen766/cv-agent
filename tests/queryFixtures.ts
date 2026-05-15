import type {
  EvidenceChainSnapshot,
  GraphViewSnapshot,
} from "../src/persistence/repositories.js";

export function createEvidenceChainSnapshot(input: {
  id: string;
  userId: string;
  sessionId?: string;
  artifactId?: string;
}): EvidenceChainSnapshot {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: input.id,
    userId: input.userId,
    sessionId: input.sessionId,
    artifactId: input.artifactId,
    chain: {
      id: `chain-${input.id}`,
      artifact: {
        id: input.artifactId ?? "artifact-1",
        userId: input.userId,
        type: "resume_bullet",
        content: "Built React systems with measurable impact.",
        sourceExperienceIds: ["exp-1"],
        sourceEvidenceIds: ["ev-1"],
        matchedSkillIds: ["skill-1"],
        targetJDId: "jd-1",
        targetRequirementIds: ["req-1"],
        targetRole: "Frontend Engineer",
        scores: {
          overall: 0.8,
          requirementMatch: 0.8,
          evidenceStrength: 0.8,
        },
        status: "ready",
        createdAt: now,
        updatedAt: now,
      },
      summary: "Evidence chain summary.",
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
      scores: {
        overall: 0.8,
        requirementMatch: 0.8,
        evidenceStrength: 0.8,
      },
      createdAt: now,
    },
    createdAt: now,
    updatedAt: now,
  };
}

export function createGraphViewSnapshot(input: {
  id: string;
  userId: string;
  scopeType: GraphViewSnapshot["scopeType"];
  scopeId: string;
}): GraphViewSnapshot {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: input.id,
    userId: input.userId,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    graph: {
      nodes: [
        {
          id: input.scopeId,
          type: input.scopeType === "artifact" ? "artifact" : "experience",
          label: "Demo node",
          detail: "Demo detail",
        },
      ],
      edges: [],
    },
    createdAt: now,
    updatedAt: now,
  };
}
