import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/api/createServer.js";
import { createKernel } from "../src/api/kernel/createKernel.js";
import {
  FakePdfRenderer,
  type PdfRendererAdapter,
  type ResumeLayoutMeasurer,
  type ResumeLayoutMeasurement,
} from "../src/exports/index.js";
import type { ApiSuccess } from "../src/api/response.js";
import type { ApiKernel } from "../src/api/types.js";
import type { BackgroundJob } from "../src/platform/index.js";
import type { ResumeExport } from "../src/exports/index.js";

/**
 * Phase 9 contract test — additive / optional / backward compatibility.
 *
 * Goals (per docs/cv_agent_next_stage_plan.md Phase 9):
 *   1. None of the Phase 1-8b additive fields are *required*. With every
 *      Phase env flag UNSET, a baseline export still completes and never
 *      reports an env-gated field.
 *   2. When a field IS present, its shape matches the contract documented
 *      in docs/CONTRACT.md section 16. We never assert any field MUST be
 *      present — that would convert "additive" into "required".
 *   3. Legacy fields (id, status, format, createdAt, …) remain unchanged.
 *
 * The kernel here is in-memory and has no model client wired, so the
 * LLM-gated fields (`editReport`, `criticReview`) are guaranteed to be
 * absent. That mirrors the configuration that consumers see when they
 * have not configured an LLM provider.
 */

function setupEnv() {
  process.env.AUTH_MODE = "dev_header";
  process.env.AGENT_PROVIDER = "mock";
  process.env.NODE_ENV = "test";
  process.env.JOB_WORKER_ENABLED = "false";
  process.env.PDF_RENDERER = "playwright";
  process.env.FILE_STORAGE_PROVIDER = "memory";
  delete process.env.DATABASE_URL;
  delete process.env.ENABLE_NARRATOR;
  delete process.env.ENABLE_LLM_FIT_EDITOR;
  delete process.env.ENABLE_LLM_QUALITY_CRITIC;
}

const measurer: ResumeLayoutMeasurer = {
  async measure(): Promise<ResumeLayoutMeasurement> {
    return { contentHeightPx: 850, pageUsableHeightPx: 987, measurer: "heuristic" };
  },
};

describe("Phase 9 contract: Phase 1-8b additive surface is optional and backward compatible", () => {
  let kernel: ApiKernel;
  let server: Awaited<ReturnType<typeof createServer>>;
  let pdfRenderer: PdfRendererAdapter;

  async function boot() {
    setupEnv();
    pdfRenderer = { async render(html: string) { return new FakePdfRenderer().render(html); } };
    kernel = await createKernel({ pdfRenderer, layoutMeasurer: measurer });
    server = await createServer(kernel);
  }

  afterEach(async () => {
    delete process.env.JOB_WORKER_ENABLED;
    delete process.env.PDF_RENDERER;
    delete process.env.FILE_STORAGE_PROVIDER;
    if (server) await server.close();
    if (kernel) await kernel.close();
  });

  async function seedResume(): Promise<string> {
    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "Phase9 Contract" });
    await kernel.productServices.resumeService.addResumeItem("user-1", resume.id, {
      title: "Senior Engineer",
      contentSnapshot: "Senior Engineer\n- Built React dashboard for analytics team.\n- Reduced page load time by 35%.",
      metadata: {
        itemId: "i-1",
        bulletIds: ["b-1", "b-2"],
        bulletTexts: { "b-1": "Built React dashboard for analytics team.", "b-2": "Reduced page load time by 35%." },
        sourceExperienceId: "exp-1",
        bulletEvidence: { "b-1": "exp-1", "b-2": "exp-1" },
        relevanceScore: 0.8,
      },
    });
    return resume.id;
  }

  async function runExport(resumeId: string, body: Record<string, unknown>): Promise<ResumeExport | null> {
    const created = await server.inject({
      method: "POST",
      url: `/exports/resumes/${resumeId}`,
      headers: { "x-user-id": "user-1", "content-type": "application/json" },
      payload: body,
    });
    expect(created.statusCode).toBe(200);
    const data = (created.json() as ApiSuccess<{ exportRecord: ResumeExport; job: BackgroundJob }>).data;
    await kernel.jobRunner.runJob(data.job.id, "user-1");
    return kernel.exportService.getExport("user-1", data.exportRecord.id);
  }
  it("baseline (no env flags, no templateId): export completes; legacy fields preserved; env-gated fields absent", async () => {
    await boot();
    const resumeId = await seedResume();
    const completed = await runExport(resumeId, { format: "html" });

    // Legacy fields preserved (Phase 9 hard rule: no rename / no removal).
    expect(completed).toBeTruthy();
    expect(completed?.id).toEqual(expect.any(String));
    expect(completed?.userId).toBe("user-1");
    expect(completed?.resumeId).toBe(resumeId);
    expect(completed?.format).toBe("html");
    expect(completed?.status).toBe("completed");
    expect(completed?.createdAt).toEqual(expect.any(String));
    expect(completed?.updatedAt).toEqual(expect.any(String));

    // Phase 7 / 8b LLM-gated fields MUST be absent when env flags are unset
    // and no model client is wired.
    expect(completed?.editReport).toBeUndefined();
    expect(completed?.qualityReport?.criticReview).toBeUndefined();
  });

  it("templateId is optional; default template emits a valid export when omitted", async () => {
    await boot();
    const resumeId = await seedResume();
    // Phase 4 contract: templateId is optional. Omitting it must not break.
    const completed = await runExport(resumeId, { format: "html" });
    expect(completed?.status).toBe("completed");
  });

  it("when a Phase 1-8b additive field is present on a completed export, its shape matches section 16", async () => {
    await boot();
    const resumeId = await seedResume();
    const completed = await runExport(resumeId, { format: "html", templateId: "one-page-modern" });
    expect(completed?.status).toBe("completed");

    // fitReport: present after completed. Shape must match section 16.5.
    if (completed?.fitReport !== undefined) {
      const fit = completed.fitReport;
      expect(typeof fit.targetPages).toBe("number");
      expect(typeof fit.estimatedPages).toBe("number");
      expect(typeof fit.overflowPx).toBe("number");
      expect(typeof fit.contentHeightPx).toBe("number");
      expect(typeof fit.pageUsableHeightPx).toBe("number");
      expect(typeof fit.templateId).toBe("string");
      expect(typeof fit.density).toBe("string");
      expect(["playwright", "heuristic"]).toContain(fit.measurer);
      expect(typeof fit.measuredAt).toBe("string");
      if (fit.underflowPx !== undefined) expect(typeof fit.underflowPx).toBe("number");
    }

    // compressionReport: optional, only present on the compression path.
    if (completed?.compressionReport !== undefined) {
      const c = completed.compressionReport;
      expect(typeof c.applied).toBe("boolean");
      expect(typeof c.iterations).toBe("number");
      expect(Array.isArray(c.actions)).toBe(true);
      expect(["overflow_resolved", "no_more_strategies", "iteration_limit"]).toContain(c.reason);
    }

    // qualityReport: optional, advisory; never blocks export.
    if (completed?.qualityReport !== undefined) {
      const q = completed.qualityReport;
      expect(typeof q.overallScore).toBe("number");
      expect(typeof q.authenticityScore).toBe("number");
      expect(typeof q.jdMatchScore).toBe("number");
      expect(typeof q.evidenceScore).toBe("number");
      expect(typeof q.metricScore).toBe("number");
      expect(typeof q.expressionScore).toBe("number");
      expect(typeof q.layoutScore).toBe("number");
      expect(Array.isArray(q.risks)).toBe(true);
      expect(Array.isArray(q.suggestions)).toBe(true);
      expect(Array.isArray(q.unsupportedClaims)).toBe(true);
      expect(typeof q.hasCriticalRisks).toBe("boolean");
      expect(typeof q.generatedAt).toBe("string");
      // hasCriticalRisks=true is allowed and must NOT block: status remains completed.
      expect(completed.status).toBe("completed");
      // When critic env flag is unset, criticReview must be absent.
      expect(q.criticReview).toBeUndefined();
    }

    // editReport: must be absent when ENABLE_LLM_FIT_EDITOR is unset.
    expect(completed?.editReport).toBeUndefined();
  });

  it("/copilot/chat raw envelope still includes legacy fields and the toolResults array", async () => {
    await boot();
    const response = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "user-1", "content-type": "application/json" },
      payload: { message: "Show my experience library" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as ApiSuccess<{ raw: Record<string, unknown> }>;
    expect(body.ok).toBe(true);
    const raw = body.data.raw;
    // Legacy raw fields preserved.
    expect(Array.isArray(raw.artifactIds)).toBe(true);
    expect(Array.isArray(raw.evidenceChainIds)).toBe(true);
    expect(Array.isArray(raw.critiqueItemIds)).toBe(true);
    expect(Array.isArray(raw.decisionIds)).toBe(true);
    // Phase 1 additive: toolResults is exposed (may be empty; never required to be non-empty).
    expect(Array.isArray((raw as { toolResults?: unknown[] }).toolResults)).toBe(true);
  });

  it("Narrator is opt-in: with ENABLE_NARRATOR unset, assistantMessage shape is preserved", async () => {
    await boot();
    expect(process.env.ENABLE_NARRATOR).toBeUndefined();
    const response = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "user-1", "content-type": "application/json" },
      payload: { message: "Hello" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as ApiSuccess<{ assistantMessage: { content: string; role: string; kind: string } }>;
    // The legacy CopilotMessage shape is unchanged: role / kind / content all present.
    expect(body.data.assistantMessage.role).toBe("assistant");
    expect(typeof body.data.assistantMessage.kind).toBe("string");
    expect(typeof body.data.assistantMessage.content).toBe("string");
    expect(body.data.assistantMessage.content.length).toBeGreaterThan(0);
  });
});
