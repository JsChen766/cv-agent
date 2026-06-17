import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/api/createServer.js";
import { createKernel } from "../src/api/kernel/createKernel.js";
import {
  FakePdfRenderer,
  HeuristicLayoutMeasurer,
  type PdfRendererAdapter,
  type ResumeLayoutMeasurer,
  type ResumeLayoutMeasurement,
} from "../src/exports/index.js";
import type { ApiSuccess } from "../src/api/response.js";
import type { ApiKernel } from "../src/api/types.js";
import type { BackgroundJob } from "../src/platform/index.js";
import type { ResumeExport } from "../src/exports/index.js";

function setupEnv() {
  process.env.AUTH_MODE = "dev_header";
  process.env.AGENT_PROVIDER = "mock";
  process.env.NODE_ENV = "test";
  process.env.JOB_WORKER_ENABLED = "false";
  process.env.PDF_RENDERER = "playwright";
  process.env.FILE_STORAGE_PROVIDER = "memory";
  delete process.env.DATABASE_URL;
}

describe("Phase 6 fit-engine v2 — rule-based compression on overflow", () => {
  let kernel: ApiKernel;
  let server: Awaited<ReturnType<typeof createServer>>;
  let pdfRenderer: PdfRendererAdapter;

  async function bootKernel(opts: { measurer?: ResumeLayoutMeasurer } = {}) {
    setupEnv();
    pdfRenderer = { async render(html: string) { return new FakePdfRenderer().render(html); } };
    const measurer = opts.measurer ?? new HeuristicLayoutMeasurer();
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

  it("compresses an overflowing resume by dropping optional bullets and writes a compressionReport", async () => {
    // Simulated measurer: page overflows while the text "DROP_ME" is in the
    // rendered HTML; once the optional bullet is removed the page fits.
    const measurer: ResumeLayoutMeasurer = {
      async measure(input): Promise<ResumeLayoutMeasurement> {
        const stillOverflow = input.html.includes("DROP_ME");
        return {
          contentHeightPx: stillOverflow ? 1300 : 900,
          pageUsableHeightPx: 987,
          measurer: "heuristic",
        };
      },
    };
    await bootKernel({ measurer });

    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "Phase6 PDF" });
    await kernel.productServices.resumeService.addResumeItem("user-1", resume.id, {
      title: "Senior Engineer",
      contentSnapshot: "Senior \u00B7 Acme \u00B7 2022 \u2013 2024\n- KEEP_BULLET impact\n- DROP_ME optional",
      metadata: {
        itemId: "i-1",
        bulletIds: ["b-keep", "b-drop"],
        bulletOptional: { "b-drop": true },
        bulletRelevance: { "b-keep": 0.9, "b-drop": 0.1 },
      },
    });

    const created = await server.inject({
      method: "POST",
      url: `/exports/resumes/${resume.id}`,
      headers: { "x-user-id": "user-1", "content-type": "application/json" },
      payload: { format: "pdf", templateId: "one-page-modern" },
    });
    expect(created.statusCode).toBe(200);
    const data = (created.json() as ApiSuccess<{ exportRecord: ResumeExport; job: BackgroundJob }>).data;
    await kernel.jobRunner.runJob(data.job.id, "user-1");

    const completed = await kernel.exportService.getExport("user-1", data.exportRecord.id);
    expect(completed?.status).toBe("completed");
    expect(completed?.fileId).toEqual(expect.any(String));

    const compression = completed?.compressionReport;
    expect(compression).toBeDefined();
    expect(compression?.applied).toBe(true);
    expect(compression?.iterations).toBeGreaterThan(0);
    expect(compression?.actions.length).toBeGreaterThan(0);
    expect(compression?.actions[0]?.type).toBe("drop_bullet");
    expect(compression?.stillOverflowing).toBe(false);
    expect(compression?.finalOverflowPx).toBe(0);
    expect(compression?.densityBefore).toBe("standard");
    expect(compression?.reason).toBe("overflow_resolved");

    // The resume row was NOT mutated — only the rendered output was.
    const dbResume = await kernel.productServices.resumeService.getResume("user-1", resume.id);
    expect(dbResume?.items[0]?.contentSnapshot).toContain("DROP_ME");
  });

  it("does NOT run compression when initial measurement says the page already fits", async () => {
    const measurer: ResumeLayoutMeasurer = {
      async measure(): Promise<ResumeLayoutMeasurement> {
        return { contentHeightPx: 600, pageUsableHeightPx: 987, measurer: "heuristic" };
      },
    };
    await bootKernel({ measurer });

    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "Fits" });
    await kernel.productServices.resumeService.addResumeItem("user-1", resume.id, {
      title: "Engineer",
      contentSnapshot: "Engineer\n- one bullet",
    });
    const created = await server.inject({
      method: "POST",
      url: `/exports/resumes/${resume.id}`,
      headers: { "x-user-id": "user-1", "content-type": "application/json" },
      payload: { format: "pdf", templateId: "one-page-modern" },
    });
    const data = (created.json() as ApiSuccess<{ exportRecord: ResumeExport; job: BackgroundJob }>).data;
    await kernel.jobRunner.runJob(data.job.id, "user-1");

    const completed = await kernel.exportService.getExport("user-1", data.exportRecord.id);
    expect(completed?.status).toBe("completed");
    expect(completed?.fitReport?.overflowPx).toBe(0);
    expect(completed?.compressionReport).toBeUndefined();
  });

  it("downgrades density to compact as a final rule-based step when bullets cannot be compressed", async () => {
    const measurer: ResumeLayoutMeasurer = {
      async measure(input): Promise<ResumeLayoutMeasurement> {
        const isCompact = /data-density="compact"/.test(input.html);
        return {
          contentHeightPx: isCompact ? 900 : 1200,
          pageUsableHeightPx: 987,
          measurer: "heuristic",
        };
      },
    };
    await bootKernel({ measurer });

    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "Density" });
    await kernel.productServices.resumeService.addResumeItem("user-1", resume.id, {
      title: "Engineer",
      contentSnapshot: "Engineer\n- a\n- b",
    });
    const created = await server.inject({
      method: "POST",
      url: `/exports/resumes/${resume.id}`,
      headers: { "x-user-id": "user-1", "content-type": "application/json" },
      payload: { format: "pdf", templateId: "one-page-modern" },
    });
    const data = (created.json() as ApiSuccess<{ exportRecord: ResumeExport; job: BackgroundJob }>).data;
    await kernel.jobRunner.runJob(data.job.id, "user-1");

    const completed = await kernel.exportService.getExport("user-1", data.exportRecord.id);
    expect(completed?.status).toBe("completed");
    const compression = completed?.compressionReport;
    expect(compression?.applied).toBe(true);
    expect(compression?.densityAfter).toBe("compact");
    const densityActions = compression?.actions.filter((a) => a.type === "drop_density") ?? [];
    expect(densityActions.length).toBe(1);
    expect(completed?.fitReport?.density).toBe("compact");
  });

  it("does NOT compress when templateId is not one-page-modern (Phase 5 warn-only path is preserved)", async () => {
    const measurer: ResumeLayoutMeasurer = {
      async measure(): Promise<ResumeLayoutMeasurement> {
        return { contentHeightPx: 1500, pageUsableHeightPx: 987, measurer: "heuristic" };
      },
    };
    await bootKernel({ measurer });

    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "Default Template" });
    await kernel.productServices.resumeService.addResumeItem("user-1", resume.id, {
      title: "Engineer",
      contentSnapshot: "Engineer\n- bullet",
    });
    const created = await server.inject({
      method: "POST",
      url: `/exports/resumes/${resume.id}`,
      headers: { "x-user-id": "user-1", "content-type": "application/json" },
      payload: { format: "pdf", templateId: "default" },
    });
    const data = (created.json() as ApiSuccess<{ exportRecord: ResumeExport; job: BackgroundJob }>).data;
    await kernel.jobRunner.runJob(data.job.id, "user-1");

    const completed = await kernel.exportService.getExport("user-1", data.exportRecord.id);
    expect(completed?.status).toBe("completed");
    expect(completed?.fitReport?.overflowPx).toBeGreaterThan(0);
    expect(completed?.compressionReport).toBeUndefined();
  });

  it("completes the export with compressionReport.stillOverflowing=true when nothing more can be done", async () => {
    const measurer: ResumeLayoutMeasurer = {
      async measure(): Promise<ResumeLayoutMeasurement> {
        // Always overflow regardless of density / item changes.
        return { contentHeightPx: 2500, pageUsableHeightPx: 987, measurer: "heuristic" };
      },
    };
    await bootKernel({ measurer });

    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "Stuck" });
    const item = await kernel.productServices.resumeService.addResumeItem("user-1", resume.id, {
      title: "Engineer",
      contentSnapshot: "Engineer\n- one",
    });
    await kernel.productServices.resumeService.updateResumeItem("user-1", item.id, { pinned: true });
    const created = await server.inject({
      method: "POST",
      url: `/exports/resumes/${resume.id}`,
      headers: { "x-user-id": "user-1", "content-type": "application/json" },
      payload: { format: "pdf", templateId: "one-page-modern" },
    });
    const data = (created.json() as ApiSuccess<{ exportRecord: ResumeExport; job: BackgroundJob }>).data;
    await kernel.jobRunner.runJob(data.job.id, "user-1");

    const completed = await kernel.exportService.getExport("user-1", data.exportRecord.id);
    expect(completed?.status).toBe("completed");
    expect(completed?.fileId).toEqual(expect.any(String));
    const compression = completed?.compressionReport;
    expect(compression?.applied).toBe(true);
    expect(compression?.stillOverflowing).toBe(true);
    // pinned item must still be visible — never hidden.
    const dbResume = await kernel.productServices.resumeService.getResume("user-1", resume.id);
    expect(dbResume?.items[0]?.hidden).toBe(false);
    expect(dbResume?.items[0]?.pinned).toBe(true);
  });
});
