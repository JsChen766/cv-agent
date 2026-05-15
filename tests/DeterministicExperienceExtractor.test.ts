import { describe, expect, it } from "vitest";
import { DeterministicExperienceExtractor } from "../src/knowledge/ingestion/extractors/DeterministicExperienceExtractor.js";
import type { ExtractedExperience } from "../src/knowledge/ingestion/extractors/types.js";

function firstExperience(result: { experiences: ExtractedExperience[] }): ExtractedExperience {
  const experience = result.experiences[0];
  if (!experience) {
    throw new Error("Expected one extracted experience.");
  }
  return experience;
}

describe("DeterministicExperienceExtractor", () => {
  it("extracts work experience from raw text", async () => {
    const extractor = new DeterministicExperienceExtractor();
    const result = await extractor.extract({
      userId: "user-1",
      rawText: [
        "As a Frontend Engineer at Acme Corp, I built a React design system.",
        "Reduced bundle size by 40% with lazy loading.",
        "Improved accessibility with WCAG patterns.",
      ].join("\n"),
    });

    expect(result.experiences).toHaveLength(1);
    expect(result.warnings).toEqual([]);
    const experience = firstExperience(result);
    expect(experience.type).toBe("project");
    expect(experience.organization).toBe("Acme Corp");
    expect(experience.role).toBe("Frontend Engineer");
    expect(experience.summary).toContain("Frontend Engineer");
    expect(experience.evidenceExcerpts).toHaveLength(3);
    expect(experience.evidenceExcerpts[0]).toContain("Frontend Engineer");
  });

  it("detects education type from university keyword", async () => {
    const extractor = new DeterministicExperienceExtractor();
    const result = await extractor.extract({
      userId: "user-1",
      rawText: "Studied at Harvard University, took CS courses.",
    });

    const experience = firstExperience(result);
    expect(experience.type).toBe("education");
    expect(experience.organization).toBe("Harvard University");
  });

  it("detects project type from built keyword", async () => {
    const extractor = new DeterministicExperienceExtractor();
    const result = await extractor.extract({
      userId: "user-1",
      rawText: "Built a React project at Acme Corp.",
    });

    expect(firstExperience(result).type).toBe("project");
  });

  it("returns Unknown Organization when no org pattern found", async () => {
    const extractor = new DeterministicExperienceExtractor();
    const result = await extractor.extract({
      userId: "user-1",
      rawText: "I worked on React components and improved performance.",
    });

    const experience = firstExperience(result);
    expect(experience.organization).toBe("Unknown Organization");
    expect(experience.role).toBe("Frontend Engineer");
  });

  it("returns Contributor when role cannot be detected", async () => {
    const extractor = new DeterministicExperienceExtractor();
    const result = await extractor.extract({
      userId: "user-1",
      rawText: "I helped my team with documentation at Acme Corp.",
    });

    expect(firstExperience(result).role).toBe("Contributor");
  });

  it("handles single-line input as single evidence excerpt", async () => {
    const extractor = new DeterministicExperienceExtractor();
    const result = await extractor.extract({
      userId: "user-1",
      rawText: "As a Backend Engineer at Beta Inc, I built APIs.",
    });

    const experience = firstExperience(result);
    expect(experience.type).toBe("project");
    expect(experience.organization).toBe("Beta Inc");
    expect(experience.evidenceExcerpts).toHaveLength(1);
  });
});
