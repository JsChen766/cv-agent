import { describe, expect, it } from "vitest";
import { DeterministicArtifactGenerator } from "../src/application/generators/DeterministicArtifactGenerator.js";
import { GeneratedArtifactSchema } from "../src/knowledge/schemas/GeneratedArtifactSchema.js";
import type { JDRequirement, Evidence, Experience } from "../src/knowledge/types.js";
import type { RetrievedExperience } from "../src/knowledge/retrieval/ExperienceRetriever.js";

function makeRetrievedExperience(overrides?: Partial<RetrievedExperience>): RetrievedExperience {
  const experience: Experience = {
    id: "exp-1",
    userId: "user-1",
    type: "work",
    organization: "Acme Corp",
    role: "Frontend Engineer",
    summary: "Built a React design system.",
    timeRange: { startDate: null, endDate: null },
    star: { situation: "x", task: "x", action: "x", result: "40% bundle reduction" },
    evidenceIds: ["ev-1", "ev-2"],
    skillIds: ["skill-react", "skill-perf"],
    confidence: 0.85,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  const evidences: Evidence[] = [
    {
      id: "ev-1",
      userId: "user-1",
      experienceId: "exp-1",
      sourceType: "raw_input",
      evidenceType: "project",
      sourceRef: "test",
      excerpt: "Built React components",
      confidence: 0.9,
      createdAt: "2024-01-01T00:00:00Z",
    },
  ];

  const skills = [
    { id: "skill-react", userId: "user-1", name: "React", category: "technical" as const, evidenceIds: ["ev-1"], createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" },
  ];

  return {
    experience,
    evidences,
    skills,
    matchedEvidences: evidences,
    matchedSkills: skills,
    matchedRequirements: [],
    matchScore: 0.85,
    matchedRequirementIds: [],
    matchedEvidenceIds: ["ev-1"],
    matchedSkillIds: ["skill-react"],
    reason: "Matched React skills",
    ...overrides,
  };
}

describe("DeterministicArtifactGenerator", () => {
  it("generates exactly 3 artifacts with experience data", async () => {
    const generator = new DeterministicArtifactGenerator();
    const requirement: JDRequirement = {
      id: "req-1",
      userId: "user-1",
      jdId: "jd-1",
      description: "React experience",
      requiredSkillIds: ["skill-react"],
      weight: 1,
      createdAt: "2024-01-01T00:00:00Z",
    };

    const result = await generator.generate({
      userId: "user-1",
      jdId: "jd-1",
      jdText: "Looking for React experience.",
      targetRole: "Frontend Engineer",
      requirements: [requirement],
      retrievedExperiences: [makeRetrievedExperience()],
    });

    expect(result).toHaveLength(3);
    const styles = ["technical", "product_impact", "architecture"];
    for (const artifact of result) {
      expect(GeneratedArtifactSchema.safeParse(artifact).success).toBe(true);
      expect(artifact.userId).toBe("user-1");
      expect(artifact.type).toBe("resume_bullet");
      expect(artifact.status).toBe("ready");
      expect(artifact.sourceExperienceIds).toHaveLength(1);
      expect(artifact.sourceEvidenceIds.length).toBeGreaterThan(0);
      expect(artifact.targetJDId).toBe("jd-1");
    }
    expect(new Set(result.map((a) => a.id)).size).toBe(3);
  });

  it("generates 3 needs_review artifacts when no experiences retrieved", async () => {
    const generator = new DeterministicArtifactGenerator();

    const result = await generator.generate({
      userId: "user-1",
      jdId: "jd-1",
      jdText: "Looking for React experience.",
      targetRole: "Frontend Engineer",
      requirements: [],
      retrievedExperiences: [],
    });

    expect(result).toHaveLength(3);
    for (const artifact of result) {
      expect(GeneratedArtifactSchema.safeParse(artifact).success).toBe(true);
      expect(artifact.status).toBe("needs_review");
      expect(artifact.sourceExperienceIds).toHaveLength(0);
      expect(artifact.sourceEvidenceIds).toHaveLength(0);
      expect(artifact.content).toContain("Draft");
    }
  });

  it("each artifact passes GeneratedArtifactSchema validation", async () => {
    const generator = new DeterministicArtifactGenerator();
    const requirement: JDRequirement = {
      id: "req-1",
      userId: "user-1",
      jdId: "jd-1",
      description: "React",
      requiredSkillIds: [],
      weight: 1,
      createdAt: "2024-01-01T00:00:00Z",
    };

    const result = await generator.generate({
      userId: "user-1",
      jdId: "jd-1",
      jdText: "test",
      targetRole: "Engineer",
      requirements: [requirement],
      retrievedExperiences: [makeRetrievedExperience()],
    });

    for (const artifact of result) {
      const parsed = GeneratedArtifactSchema.safeParse(artifact);
      expect(parsed.success).toBe(true);
    }
  });
});
