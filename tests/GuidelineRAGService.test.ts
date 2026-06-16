import { describe, expect, it } from "vitest";
import {
  GuidelineRAGService,
  InMemoryGuidelineRepository,
} from "../src/rag/guideline/index.js";

describe("Guideline RAG v2", () => {
  it("builds a role-aware instruction pack with retrieved guideline trace", async () => {
    const service = new GuidelineRAGService({ repository: new InMemoryGuidelineRepository() });
    const pack = await service.buildInstructionPack({
      userId: "user-1",
      targetRole: "Product Analyst Intern",
      jdText: "We need an intern with user research, market analysis, stakeholder communication, and data-driven product decision experience.",
    });

    expect(pack.version).toBe("guideline-rag-v2");
    expect(pack.roleFamily).toBe("product");
    expect(pack.writingRules.length).toBeGreaterThan(0);
    expect(pack.negativeConstraints.some((rule) => rule.toLowerCase().includes("invent"))).toBe(true);
    expect(pack.retrievalTrace.length).toBeGreaterThan(0);
  });
});
