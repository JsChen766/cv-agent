import { describe, expect, it } from "vitest";
import { DeterministicExperienceExtractor } from "../src/knowledge/ingestion/extractors/DeterministicExperienceExtractor.js";

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

    expect(result.type).toBe("project");
    expect(result.organization).toBe("Acme Corp");
    expect(result.role).toBe("Frontend Engineer");
    expect(result.summary).toContain("Frontend Engineer");
    expect(result.evidenceExcerpts).toHaveLength(3);
    expect(result.evidenceExcerpts[0]).toContain("Frontend Engineer");
  });

  it("detects education type from university keyword", async () => {
    const extractor = new DeterministicExperienceExtractor();
    const result = await extractor.extract({
      userId: "user-1",
      rawText: "Studied at Harvard University, took CS courses.",
    });

    expect(result.type).toBe("education");
    expect(result.organization).toBe("Harvard University");
  });

  it("detects project type from built keyword", async () => {
    const extractor = new DeterministicExperienceExtractor();
    const result = await extractor.extract({
      userId: "user-1",
      rawText: "Built a React project at Acme Corp.",
    });

    expect(result.type).toBe("project");
  });

  it("returns Unknown Organization when no org pattern found", async () => {
    const extractor = new DeterministicExperienceExtractor();
    const result = await extractor.extract({
      userId: "user-1",
      rawText: "I worked on React components and improved performance.",
    });

    expect(result.organization).toBe("Unknown Organization");
    expect(result.role).toBe("Frontend Engineer");
  });

  it("returns Contributor when role cannot be detected", async () => {
    const extractor = new DeterministicExperienceExtractor();
    const result = await extractor.extract({
      userId: "user-1",
      rawText: "I helped my team with documentation at Acme Corp.",
    });

    expect(result.role).toBe("Contributor");
  });

  it("handles single-line input as single evidence excerpt", async () => {
    const extractor = new DeterministicExperienceExtractor();
    const result = await extractor.extract({
      userId: "user-1",
      rawText: "As a Backend Engineer at Beta Inc, I built APIs.",
    });

    expect(result.type).toBe("project");
    expect(result.organization).toBe("Beta Inc");
    expect(result.evidenceExcerpts).toHaveLength(1);
  });
});
