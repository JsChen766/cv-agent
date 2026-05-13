import { describe, expect, it } from "vitest";
import { createInMemoryCooltoDemoService } from "../src/application/CooltoDemoService.js";

describe("CooltoDemoService", () => {
  it("runs ingest and generation into frontend contract responses", async () => {
    const service = createInMemoryCooltoDemoService();

    const result = await service.run({
      userId: "user-1",
      rawExperienceText: [
        "As a Senior Frontend Engineer at Acme Corp, I led a React design system.",
        "Built TypeScript components with accessibility standards.",
        "Reduced bundle size by 40% with performance optimization.",
      ].join("\n"),
      jdText:
        "Looking for React, TypeScript, performance optimization, accessibility, and design system experience.",
      targetRole: "Senior Frontend Engineer",
    });

    expect(result.ingest.experience.userId).toBe("user-1");
    expect(result.ingest.evidences.length).toBeGreaterThan(0);
    expect(result.generation.artifacts.length).toBeGreaterThanOrEqual(3);
    for (const bundle of result.generation.artifacts) {
      expect(bundle.artifact).toBeDefined();
      expect(bundle.evidenceChain).toBeDefined();
      expect(bundle.graphView).toBeDefined();
    }
  });
});
