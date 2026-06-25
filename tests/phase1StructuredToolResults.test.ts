import { describe, expect, it } from "vitest";
import { createExportAgentTools } from "../src/agent-tools/export/index.js";
import { createExperienceAgentTools } from "../src/agent-tools/experience/index.js";
import { createP12Kernel, testContext } from "./p12Helpers.js";

/**
 * Phase 1 — verify the *behavioral* contract that the four remaining target
 * tools (`prepare_export_resume`, `export_resume`, `get_export`,
 * `match_experiences_against_jd`) emit the new structured ToolResult fields
 * (resultKind / summaryFacts / entities / nextActionHints / warnings)
 * **without** dropping any of the legacy fields (message / data /
 * workspacePatch / actionResult / visibility).
 *
 * The two resume-side tools are exercised in tests/resumeAgentTools.test.ts.
 */
describe("Phase 1 structured tool results — export & match tools", () => {
  it("prepare_export_resume returns export_prepared resultKind + nextActionHint", async () => {
    const kernel = await createP12Kernel();
    const tool = createExportAgentTools().find((item) => item.name === "prepare_export_resume");
    expect(tool).toBeDefined();
    try {
      const result = await tool!.execute(
        { resumeId: "res-1", format: "pdf" },
        testContext(kernel, [tool!]),
      );
      // Legacy contract preserved
      expect(result.status).toBe("success");
      expect(result.message).toBe("Prepared resume export for confirmation.");
      expect(result.actionResult?.status).toBe("needs_confirmation");
      expect(result.actionResult?.actionType).toBe("export_resume");
      // Phase 1 structured fields
      expect(result.resultKind).toBe("export_prepared");
      expect(result.summaryFacts?.length).toBeGreaterThan(0);
      const types = new Set((result.entities ?? []).map((entity) => entity.type));
      expect(types.has("resume")).toBe(true);
      const hintTypes = new Set((result.nextActionHints ?? []).map((hint) => hint.type));
      expect(hintTypes.has("export_resume")).toBe(true);
    } finally {
      await kernel.close();
    }
  });

  it("export_resume returns export_pending resultKind with export + background_job entities", async () => {
    const kernel = await createP12Kernel();
    const resume = await kernel.productServices.resumeService.createResume("user-1", {
      title: "Phase1 export resume",
    });
    const tool = createExportAgentTools().find((item) => item.name === "export_resume");
    expect(tool).toBeDefined();
    try {
      const result = await tool!.execute(
        { resumeId: resume.id, format: "html" },
        testContext(kernel, [tool!]),
      );
      // Legacy contract preserved
      expect(result.status).toBe("success");
      expect(result.message).toContain("简历导出任务已创建");
      expect(result.actionResult?.actionType).toBe("export_resume");
      expect(result.workspacePatch?.activePanel).toBe("resume_editor");
      // Phase 1 structured fields
      expect(result.resultKind).toBe("export_pending");
      expect(result.summaryFacts?.length).toBeGreaterThan(0);
      const types = new Set((result.entities ?? []).map((entity) => entity.type));
      expect(types.has("export")).toBe(true);
      expect(types.has("background_job")).toBe(true);
      const hintTypes = new Set((result.nextActionHints ?? []).map((hint) => hint.type));
      expect(hintTypes.has("get_export")).toBe(true);
    } finally {
      await kernel.close();
    }
  });

  it("get_export returns export_not_found resultKind when missing", async () => {
    const kernel = await createP12Kernel();
    const tool = createExportAgentTools().find((item) => item.name === "get_export");
    expect(tool).toBeDefined();
    try {
      const result = await tool!.execute(
        { id: "missing-export-id" },
        testContext(kernel, [tool!]),
      );
      expect(result.status).toBe("failed");
      // Phase 1 structured fields on the failure path
      expect(result.resultKind).toBe("export_not_found");
      expect(result.summaryFacts?.length).toBeGreaterThan(0);
      expect(result.warnings?.length).toBeGreaterThan(0);
      const types = new Set((result.entities ?? []).map((entity) => entity.type));
      expect(types.has("export")).toBe(true);
    } finally {
      await kernel.close();
    }
  });

  it("get_export returns export_pending or export_ready with download hint when present", async () => {
    const kernel = await createP12Kernel();
    const resume = await kernel.productServices.resumeService.createResume("user-1", {
      title: "Phase1 get_export resume",
    });
    const created = await kernel.exportService.createExport("user-1", {
      resumeId: resume.id,
      format: "html",
    });
    const tool = createExportAgentTools().find((item) => item.name === "get_export");
    expect(tool).toBeDefined();
    try {
      const result = await tool!.execute(
        { id: created.exportRecord.id },
        testContext(kernel, [tool!]),
      );
      expect(result.status).toBe("success");
      expect(["export_pending", "export_ready"]).toContain(result.resultKind);
      const types = new Set((result.entities ?? []).map((entity) => entity.type));
      expect(types.has("export")).toBe(true);
      const hintTypes = new Set((result.nextActionHints ?? []).map((hint) => hint.type));
      // Either we suggest polling again (pending) or downloading (ready).
      expect(hintTypes.has("poll_export") || hintTypes.has("download_export")).toBe(true);
    } finally {
      await kernel.close();
    }
  });

  it("match_experiences_against_jd returns match_completed with entities + evidence + nextActionHints", async () => {
    const kernel = await createP12Kernel();
    await kernel.productServices.experienceService.createExperience("user-1", {
      title: "Vue 3 perf rewrite",
      content: "Rewrote dashboard in Vue 3 + TypeScript and improved TTI by 40%.",
      role: "Senior Frontend Engineer",
      organization: "Acme",
    });
    const tool = createExperienceAgentTools().find((item) => item.name === "match_experiences_against_jd");
    expect(tool).toBeDefined();
    try {
      const result = await tool!.execute(
        { jdText: "Senior Frontend Engineer with Vue 3 and TypeScript and performance optimization.", limit: 10 },
        testContext(kernel, [tool!]),
      );
      expect(result.status).toBe("success");
      // Legacy contract preserved
      expect(result.actionResult?.actionType).toBe("match_experiences_against_jd");
      expect(result.workspacePatch?.activePanel).toBe("jd_matching");
      const data = result.data as { jdAnalysis?: unknown } | undefined;
      expect(data?.jdAnalysis).toMatchObject({
        hardRequirements: expect.any(Array),
        responsibilities: expect.any(Array),
      });
      // Phase 1 structured fields (success path → match_completed)
      expect(result.resultKind).toBe("match_completed");
      expect(result.summaryFacts?.length).toBeGreaterThan(0);
      const types = new Set((result.entities ?? []).map((entity) => entity.type));
      expect(types.has("experience")).toBe(true);
      // Evidence array exists (may be empty if no matches found, but field is at least an array)
      expect(Array.isArray(result.evidence)).toBe(true);
      // nextActionHints array exists
      expect(Array.isArray(result.nextActionHints)).toBe(true);
    } finally {
      await kernel.close();
    }
  });

  it("match_experiences_against_jd returns match_empty when the experience library is empty", async () => {
    const kernel = await createP12Kernel();
    const tool = createExperienceAgentTools().find((item) => item.name === "match_experiences_against_jd");
    expect(tool).toBeDefined();
    try {
      const result = await tool!.execute(
        { jdText: "Senior Frontend Engineer with Vue 3.", limit: 10 },
        testContext(kernel, [tool!]),
      );
      expect(result.status).toBe("success");
      expect(result.resultKind).toBe("match_empty");
      expect(result.summaryFacts?.length).toBeGreaterThan(0);
      expect((result.warnings ?? []).length).toBeGreaterThan(0);
      const hintTypes = new Set((result.nextActionHints ?? []).map((hint) => hint.type));
      expect(hintTypes.has("import_resume_file")).toBe(true);
    } finally {
      await kernel.close();
    }
  });
});
