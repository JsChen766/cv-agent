import { describe, expect, it } from "vitest";
import { createResumeAgentTools } from "../src/agent-tools/resume/index.js";
import { createP12Kernel, testContext } from "./p12Helpers.js";

describe("resume agent tools", () => {
  it("generate_resume_from_jd returns generation data and workspace variants", async () => {
    const kernel = await createP12Kernel();
    await kernel.productServices.experienceService.createExperience("user-1", {
      title: "React performance platform",
      content: "Built a React and TypeScript analytics platform and reduced bundle size by 40%.",
      role: "Frontend Engineer",
      organization: "Acme",
    });
    const tool = createResumeAgentTools().find((item) => item.name === "generate_resume_from_jd");
    expect(tool).toBeDefined();

    try {
      const result = await tool!.execute({
        jdText: "Frontend Engineer role requiring React, TypeScript and performance optimization.",
        targetRole: "Frontend Engineer",
      }, testContext(kernel, [tool!]));

      expect(result.status).toBe("success");
      expect(result.message).toContain("已基于 JD 生成");
      expect(result.data).toMatchObject({
        generationId: expect.any(String),
        jd: { id: expect.any(String) },
        variants: expect.any(Array),
        generation: { id: expect.any(String) },
      });
      const data = result.data as { variants: Array<{ id: string; content: string; createdAt: string }> };
      expect(data.variants.length).toBeGreaterThan(0);
      expect(data.variants[0]).toMatchObject({
        id: expect.any(String),
        content: expect.stringContaining("目标岗位"),
        createdAt: expect.any(String),
      });
      expect(result.workspacePatch).toMatchObject({
        productGenerationId: expect.any(String),
        jdId: expect.any(String),
        variants: expect.any(Array),
        status: "ready",
      });
      expect((result.workspacePatch?.variants as unknown[]).length).toBeGreaterThan(0);
      expect(result.actionResult).toMatchObject({
        status: "success",
        actionType: "generate_resume_from_jd",
        metadata: {
          generationId: expect.any(String),
          variantCount: expect.any(Number),
        },
      });
    } finally {
      await kernel.close();
    }
  });

  it("accept_generation_variant returns workspacePatch with resumeId, activeResume, status accepted", async () => {
    const kernel = await createP12Kernel();
    // Create a generation first so we have something to accept
    const genResult = await kernel.productServices.generationProductService.generateResumeFromJD({
      userId: "user-1",
      jdText: "React developer role.",
      targetRole: "Frontend",
    });
    const variant = genResult.variants[0]!;

    const tool = createResumeAgentTools().find((item) => item.name === "accept_generation_variant");
    expect(tool).toBeDefined();

    try {
      const result = await tool!.execute({
        generationId: genResult.generation.id,
        variantId: variant.id,
      }, testContext(kernel, [tool!]));

      expect(result.status).toBe("success");
      expect(result.actionResult).toMatchObject({
        status: "success",
        actionType: "accept_generation_variant",
      });
      expect(result.actionResult?.metadata).toMatchObject({
        generationId: genResult.generation.id,
        resumeId: expect.any(String),
      });
      expect(result.workspacePatch).toMatchObject({
        activePanel: "resume_editor",
        resumeId: expect.any(String),
        status: "accepted",
        summary: "已将选中的版本保存到简历。",
      });
      expect(result.workspacePatch?.activeResume).toBeTruthy();
      expect(result.workspacePatch?.active).toMatchObject({
        resumeId: expect.any(String),
        variantId: variant.id,
      });
    } finally {
      await kernel.close();
    }
  });

  it("revise_resume_item does NOT write fake [基于指令优化: ...] text", async () => {
    const kernel = await createP12Kernel();
    const tool = createResumeAgentTools().find((item) => item.name === "revise_resume_item");
    expect(tool).toBeDefined();

    try {
      const result = await tool!.execute({
        resumeItemId: "item-1",
        instruction: "Make it more concise.",
      }, testContext(kernel, [tool!]));

      // Must NOT succeed with fake text — either model unavailable or source text not found
      expect(result.status).toBe("needs_input");
      expect(result.visibility).toBe("error_user_visible");
      expect(result.actionResult?.status).toBe("needs_input");
      expect(result.actionResult?.actionType).toBe("optimize_resume_item");
      // Valid failure reasons: model_not_available (no LLM), source_text_not_found (no workspace item)
      expect(["model_not_available", "source_text_not_found"]).toContain(result.actionResult?.reason);
      // Must NOT contain the fake prefix
      expect(result.message).not.toContain("[基于指令优化:");
    } finally {
      await kernel.close();
    }
  });
});
