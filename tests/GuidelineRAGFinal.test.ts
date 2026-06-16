import { describe, expect, it } from "vitest";
import { GuidelineRAGService, InMemoryGuidelineRepository } from "../src/rag/guideline/index.js";

describe("Guideline RAG v2 finalization", () => {
  it("builds a safe and role-specific AI/ML instruction pack with source diversity", async () => {
    const service = new GuidelineRAGService({ repository: new InMemoryGuidelineRepository() });
    const pack = await service.buildInstructionPack({
      userId: "user-1",
      targetRole: "AI Algorithm Engineer Intern",
      jdText: "参与大语言模型、VQA、多模态、RLHF 和 AIGC 算法研发，要求熟悉 Python、PyTorch、Transformer，并有顶会科研经历。",
    });

    expect(pack.version).toBe("guideline-rag-v2");
    expect(pack.roleFamily).toBe("ai_ml");
    expect(pack.hardConstraints?.some((rule) => /invent|不得|only facts|evidence/i.test(rule))).toBe(true);
    expect(pack.quality?.mandatoryConstraintsPresent).toBe(true);
    expect(pack.retrievalTrace.some((item) => item.sourceType === "role_template")).toBe(true);
    expect(pack.retrievalTrace.some((item) => item.sourceType === "rule")).toBe(true);
    expect(pack.examplePatterns.every((item) => !/\b\d+%\b/.test(item.pattern))).toBe(true);
  });

  it("retains mandatory factual constraints even for a different role family", async () => {
    const service = new GuidelineRAGService({ repository: new InMemoryGuidelineRepository() });
    const pack = await service.buildInstructionPack({
      userId: "user-1",
      targetRole: "Product Analyst Intern",
      jdText: "Conduct user research, analyze product data, and communicate recommendations to stakeholders.",
    });

    expect(pack.roleFamily).toBe("product");
    expect(pack.negativeConstraints.some((rule) => /invent|不得|only facts|evidence/i.test(rule))).toBe(true);
    expect(pack.sectionStrategy.experience).toBeTruthy();
    expect(pack.sectionBudgets?.experience).toBeTruthy();
  });
  it("ingests external rules and exemplar documents as traceable guideline chunks", async () => {
    const repository = new InMemoryGuidelineRepository([]);
    const service = new GuidelineRAGService({ repository });
    const chunks = await service.ingestGuidelines([{
      sourceId: "resume-handbook-1",
      sourceType: "rule",
      title: "AI Resume Handbook",
      content: "AI resume bullets should state the verified model, method, dataset, and evaluation result.\n\nDo not invent benchmark gains.",
      roleFamily: "ai_ml",
      language: "en",
      tags: ["AI", "evaluation"],
    }]);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].metadata.provenance).toBe("resume-handbook-1");
    const pack = await service.buildInstructionPack({
      userId: "user-1",
      targetRole: "AI Engineer",
      jdText: "Build and evaluate LLM systems.",
    });
    expect(pack.retrievalTrace.some((item) => item.guidelineId.includes("resume-handbook-1"))).toBe(true);
  });

});
