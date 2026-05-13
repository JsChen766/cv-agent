import { describe, expect, it } from "vitest";
import { GraphViewBuilder } from "../src/knowledge/GraphViewBuilder.js";
import type { EvidenceChain } from "../src/knowledge/index.js";

describe("GraphViewBuilder", () => {
  it("builds frontend-ready graph nodes and edges", () => {
    const chain: EvidenceChain = {
      artifact: {
        id: "artifact-1",
        userId: "user-1",
        type: "resume_bullet",
        content: "Delivered React performance impact.",
        sourceExperienceIds: ["exp-1"],
        sourceEvidenceIds: ["ev-1"],
        matchedSkillIds: ["skill-react"],
        targetJDId: "jd-1",
        targetRequirementIds: ["req-1"],
        targetRole: "Frontend Engineer",
        scores: {
          overall: 0.9,
          requirementMatch: 0.9,
          evidenceStrength: 0.95,
        },
        status: "ready",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      },
      experiences: [
        {
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
        },
      ],
      evidences: [
        {
          id: "ev-1",
          userId: "user-1",
          experienceId: "exp-1",
          sourceType: "raw_input",
          evidenceType: "metric",
          sourceRef: "test",
          excerpt: "Reduced bundle size by 40%.",
          confidence: 0.95,
          createdAt: "2025-01-01T00:00:00Z",
        },
      ],
      skills: [
        {
          id: "skill-react",
          userId: "user-1",
          name: "React",
          category: "technical",
          evidenceIds: ["ev-1"],
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2025-01-01T00:00:00Z",
        },
      ],
      requirements: [
        {
          id: "req-1",
          userId: "user-1",
          jdId: "jd-1",
          description: "React performance experience.",
          requiredSkillIds: ["skill-react"],
          weight: 1,
          createdAt: "2025-01-01T00:00:00Z",
        },
      ],
      risk: {
        level: "low",
        reasons: [],
      },
      scores: {
        overall: 0.9,
        requirementMatch: 0.9,
        evidenceStrength: 0.95,
      },
    };

    const graph = new GraphViewBuilder().build(chain);

    expect(graph.nodes.map((node) => node.type)).toEqual(
      expect.arrayContaining([
        "artifact",
        "experience",
        "evidence",
        "skill",
        "requirement",
      ]),
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "artifact-1",
          target: "req-1",
          type: "targets",
          weight: 1,
        }),
        expect.objectContaining({
          source: "ev-1",
          target: "artifact-1",
          type: "supported_by",
        }),
      ]),
    );
  });
});
