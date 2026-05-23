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
});
