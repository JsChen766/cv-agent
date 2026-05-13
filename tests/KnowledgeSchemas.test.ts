import { describe, expect, it } from "vitest";
import {
  GeneratedArtifactSchema,
  validateGeneratedArtifact,
} from "../src/knowledge/index.js";
import type { GeneratedArtifact } from "../src/knowledge/index.js";

describe("knowledge runtime schemas", () => {
  it("accepts a valid generated artifact", () => {
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

    expect(GeneratedArtifactSchema.is(artifact)).toBe(true);
    expect(validateGeneratedArtifact(artifact)).toBe(artifact);
  });

  it("rejects invalid generated artifact payloads at runtime", () => {
    expect(() =>
      validateGeneratedArtifact({
        id: "artifact-1",
        userId: "user-1",
        type: "resume_bullet",
        content: "Delivered React impact.",
        sourceExperienceIds: "exp-1",
      }),
    ).toThrow(/sourceExperienceIds/);
  });
});
