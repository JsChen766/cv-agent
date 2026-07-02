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
      const data = result.data as {
        variants: Array<{ id: string; content: string; createdAt: string }>;
        resumeChangeSet?: { summary?: { pendingCount?: number; label?: string }; changes?: unknown[] };
        editorialCriticReview?: { summary?: { totalItems?: number; autoFixableCount?: number }; patchSuggestions?: unknown[] };
        criticPatchSuggestions?: unknown[];
        resumePreviewSnapshots?: Array<{ stage?: string; resumeDocumentDraft?: unknown }>;
        resumeDocumentDraft?: { sections?: unknown[] };
        generation?: { inputSnapshot?: Record<string, unknown>; outputSnapshot?: Record<string, unknown> };
      };
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
        workflowStatus: {
          runId: expect.any(String),
          currentStage: "change_set_ready",
        },
      });
      expect((result.workspacePatch?.variants as unknown[]).length).toBeGreaterThan(0);
      expect(result.actionResult).toMatchObject({
        status: "success",
        actionType: "generate_resume_from_jd",
        metadata: {
          generationId: expect.any(String),
          variantCount: expect.any(Number),
          workflowRunId: expect.any(String),
        },
      });
      const workflowStatus = (result.data as { workflowStatus?: { stages?: Array<{ stage: string; status: string }> } }).workflowStatus;
      expect(workflowStatus?.stages?.find((stage) => stage.stage === "draft_generation")?.status).toBe("completed");
      expect(workflowStatus?.stages?.find((stage) => stage.stage === "layout_check")?.status).toBe("pending");
      const analysisReport = (result.data as { analysisReport?: { rubricVersion?: string; dimensions?: unknown[]; requirements?: unknown[] } }).analysisReport;
      expect(analysisReport).toMatchObject({
        rubricVersion: "resume-optimization-rubric-v1",
        dimensions: expect.any(Array),
        requirements: expect.any(Array),
      });
      expect(analysisReport?.dimensions).toHaveLength(10);
      expect(data.resumeChangeSet).toMatchObject({
        summary: {
          pendingCount: expect.any(Number),
          label: expect.stringContaining("waiting for review"),
        },
        changes: expect.any(Array),
      });
      expect(data.generation?.inputSnapshot?.analysisReport).toBeTruthy();
      expect(data.editorialCriticReview).toMatchObject({
        summary: {
          totalItems: expect.any(Number),
          autoFixableCount: expect.any(Number),
        },
        patchSuggestions: expect.any(Array),
      });
      expect(data.criticPatchSuggestions).toEqual(expect.any(Array));
      expect(data.generation?.inputSnapshot?.editorialCriticReview).toBeTruthy();
      expect(data.generation?.outputSnapshot?.analysisReport).toBeTruthy();
      expect(data.generation?.outputSnapshot?.editorialCriticReview).toBeTruthy();
      expect(data.generation?.outputSnapshot?.criticPatchSuggestions).toBeTruthy();
      expect(data.generation?.outputSnapshot?.resumeChangeSet).toBeTruthy();
      expect(data.resumePreviewSnapshots?.map((snapshot) => snapshot.stage)).toEqual(expect.arrayContaining([
        "original_parsed_resume",
        "problem_markers",
        "rewrite_plan",
        "patched_draft",
        "critic_repaired_draft",
      ]));
      expect(data.resumeDocumentDraft?.sections?.length).toBeGreaterThan(0);
      expect(data.generation?.inputSnapshot?.resumePreviewSnapshots).toBeTruthy();
      expect(data.generation?.outputSnapshot?.resumeDocumentDraft).toBeTruthy();
      expect(result.workspacePatch?.resumePreviewSnapshots).toBeTruthy();
      expect(result.workspacePatch?.resumeDocumentDraft).toBeTruthy();
      expect(result.workspacePatch?.resumeChangeSet).toBeTruthy();
      expect(result.workspacePatch?.editorialCriticReview).toBeTruthy();
      expect(result.workspacePatch?.criticPatchSuggestions).toBeTruthy();
      const metadata = result.actionResult?.metadata as {
        changeSetId?: string;
        criticReviewId?: string;
        criticItemCount?: number;
        criticPatchSuggestionCount?: number;
      } | undefined;
      expect(metadata?.changeSetId).toEqual(data.resumeChangeSet ? expect.any(String) : undefined);
      expect(metadata?.criticReviewId).toEqual(expect.any(String));
      expect(metadata?.criticItemCount).toEqual(expect.any(Number));
      expect(metadata?.criticPatchSuggestionCount).toEqual(expect.any(Number));
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
      expect(["optimize_resume_item", "revise_resume_item"]).toContain(result.actionResult?.actionType);
      // Valid failure reasons: model_not_available (no LLM), source_text_not_found (no workspace item)
      expect(["model_not_available", "source_text_not_found"]).toContain(result.actionResult?.reason);
      // Must NOT contain the fake prefix
      expect(result.message).not.toContain("[基于指令优化:");
    } finally {
      await kernel.close();
    }
  });

  it("Phase 1 — generate_resume_from_jd emits structured summaryFacts / entities / nextActionHints alongside legacy fields", async () => {
    const kernel = await createP12Kernel();
    await kernel.productServices.experienceService.createExperience("user-1", {
      title: "Vue performance migration",
      content: "Migrated a Vue 2 dashboard to Vue 3 + TypeScript and reduced TTI by 35%.",
      role: "Senior Frontend Engineer",
      organization: "Acme",
    });
    const tool = createResumeAgentTools().find((item) => item.name === "generate_resume_from_jd");
    expect(tool).toBeDefined();

    try {
      const result = await tool!.execute({
        jdText: "Senior Frontend Engineer; Vue 3, TypeScript, performance optimization.",
        targetRole: "Senior Frontend Engineer",
      }, testContext(kernel, [tool!]));

      expect(result.status).toBe("success");
      // Legacy fields are unchanged
      expect(result.message).toContain("已基于 JD 生成");
      expect(result.workspacePatch).toBeTruthy();
      expect(result.actionResult?.actionType).toBe("generate_resume_from_jd");

      // Phase 1 structured fields are present
      expect(result.resultKind).toBe("generation_completed");
      expect(Array.isArray(result.summaryFacts)).toBe(true);
      expect(result.summaryFacts!.length).toBeGreaterThan(0);
      expect(result.summaryFacts!.some((line) => line.includes("Generated"))).toBe(true);

      expect(Array.isArray(result.entities)).toBe(true);
      const entityTypes = new Set((result.entities ?? []).map((entity) => entity.type));
      expect(entityTypes.has("generation")).toBe(true);
      expect(entityTypes.has("jd")).toBe(true);
      expect(entityTypes.has("resume_variant")).toBe(true);

      expect(Array.isArray(result.nextActionHints)).toBe(true);
      const hintTypes = new Set((result.nextActionHints ?? []).map((hint) => hint.type));
      expect(hintTypes.has("accept_generation_variant")).toBe(true);
    } finally {
      await kernel.close();
    }
  });

  it("Phase 1 — accept_generation_variant emits resultKind=variant_accepted and export hint", async () => {
    const kernel = await createP12Kernel();
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
      // Legacy contract intact
      expect(result.workspacePatch?.status).toBe("accepted");
      expect(result.actionResult?.actionType).toBe("accept_generation_variant");

      // Phase 1 structured fields
      expect(result.resultKind).toBe("variant_accepted");
      expect(result.summaryFacts?.length).toBeGreaterThan(0);
      const types = new Set((result.entities ?? []).map((entity) => entity.type));
      expect(types.has("resume")).toBe(true);
      expect(types.has("resume_variant")).toBe(true);
      expect(types.has("resume_item")).toBe(true);
      const hintTypes = new Set((result.nextActionHints ?? []).map((hint) => hint.type));
      expect(hintTypes.has("export_resume")).toBe(true);
    } finally {
      await kernel.close();
    }
  });
});
