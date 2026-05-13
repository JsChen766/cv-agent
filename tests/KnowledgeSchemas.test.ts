import { describe, expect, it } from "vitest";
import {
  ExperienceSchema,
  GeneratedArtifactSchema,
  GraphViewSchema,
  validateEvidenceChain,
  validateExperience,
  validateGeneratedArtifact,
} from "../src/knowledge/index.js";
import type {
  Experience,
  GeneratedArtifact,
  GraphView,
} from "../src/knowledge/index.js";

const experience: Experience = {
  id: "exp-1",
  userId: "user-1",
  type: "work",
  organization: "Acme Corp",
  role: "Frontend Engineer",
  summary: "Built a React design system.",
  timeRange: { startDate: null, endDate: null },
  star: {
    situation: "Teams needed reusable UI.",
    task: "Lead frontend platform work.",
    action: "Built components.",
    result: "Improved delivery.",
  },
  evidenceIds: ["ev-1"],
  skillIds: ["skill-react"],
  confidence: 0.9,
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
};

const artifact: GeneratedArtifact = {
  id: "artifact-1",
  userId: "user-1",
  type: "resume_bullet",
  content: "Delivered React impact.",
  sourceExperienceIds: ["exp-1"],
  sourceEvidenceIds: ["ev-1"],
  matchedSkillIds: ["skill-react"],
  targetJDId: "jd-1",
  targetRequirementIds: ["req-1"],
  targetRole: "Frontend Engineer",
  scores: {
    overall: 0.9,
    requirementMatch: 0.9,
    evidenceStrength: 0.8,
  },
  status: "ready",
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
};

describe("knowledge zod schemas", () => {
  it("accepts a valid Experience", () => {
    expect(ExperienceSchema.safeParse(experience).success).toBe(true);
    expect(validateExperience(experience)).toEqual(experience);
  });

  it("returns clear errors for an invalid Experience", () => {
    expect(() =>
      validateExperience({ ...experience, timeRange: { startDate: 123 } }),
    ).toThrow(/Experience validation failed:[\s\S]*timeRange.startDate/);
  });

  it("accepts a valid GeneratedArtifact", () => {
    expect(GeneratedArtifactSchema.safeParse(artifact).success).toBe(true);
    expect(validateGeneratedArtifact(artifact)).toEqual(artifact);
  });

  it("returns clear errors for an invalid EvidenceChain", () => {
    expect(() =>
      validateEvidenceChain({
        id: "chain-1",
        artifact,
        summary: "Invalid chain.",
        requirementMatches: "not-an-array",
      }),
    ).toThrow(/EvidenceChain validation failed:[\s\S]*requirementMatches/);
  });

  it("accepts a valid GraphView", () => {
    const graph: GraphView = {
      nodes: [
        {
          id: "artifact-1",
          type: "artifact",
          label: "Resume Bullet",
          detail: "Delivered React impact.",
        },
      ],
      edges: [],
    };

    expect(GraphViewSchema.safeParse(graph).success).toBe(true);
  });
});
