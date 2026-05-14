import { describe, expect, it } from "vitest";
import { createInMemoryCooltoDemoService } from "../src/application/CooltoDemoService.js";

describe("CooltoDemoService", () => {
  it("runs ingest and generation into frontend contract responses", async () => {
    const service = createInMemoryCooltoDemoService();

    const result = await service.run({
      userId: "user-1",
      rawExperienceText: [
        "As a Senior Frontend Engineer at Acme Corp, I led a React design system.",
        "Built TypeScript components with accessibility standards and shared API integration patterns.",
        "Reduced bundle size by 40% with performance optimization.",
      ].join("\n"),
      jdText:
        "Looking for React, TypeScript, performance optimization, accessibility, API integration, design system, and cross-team collaboration experience.",
      targetRole: "Senior Frontend Engineer",
    });

    expect(result.ingest.experience.userId).toBe("user-1");
    expect(result.ingest.evidences.length).toBeGreaterThan(0);
    expect(result.generation.artifacts.length).toBeGreaterThanOrEqual(3);
    expect(result.generation.coverageReport.totalRequirements).toBeGreaterThan(1);
    expect(result.generation.coverageReport.items.length).toBe(result.generation.requirements.length);
    expect(result.generation.coverageReport.evidenceAvailableButNotUsedRequirementIds.length).toBeGreaterThan(0);
    expect(result.generation.coverageReport.noEvidenceRequirementIds.length).toBeGreaterThan(0);
    expect(result.generation.coverageGapReport.items.some((item) => item.gapType === "missing_artifact")).toBe(true);
    expect(result.generation.coverageGapReport.items.some((item) => item.gapType === "missing_evidence")).toBe(true);
    expect(result.generation.critiqueReport.items.length).toBe(result.generation.artifacts.length);
    const artifactIds = new Set(result.generation.artifacts.map((bundle) => bundle.artifact.id));
    expect(
      result.generation.critiqueReport.items.every((item) => artifactIds.has(item.artifactId)),
    ).toBe(true);
    for (const bundle of result.generation.artifacts) {
      expect(bundle.artifact).toBeDefined();
      expect(bundle.evidenceChain).toBeDefined();
      expect(bundle.graphView).toBeDefined();
    }
  });
});
