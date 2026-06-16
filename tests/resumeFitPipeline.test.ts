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

describe("Phase 5 fit-engine — fitReport persisted on completed exports", () => {
  let kernel: ApiKernel;
  let server: Awaited<ReturnType<typeof createServer>>;
  let pdfRenderer: PdfRendererAdapter;
  let measurer: ResumeLayoutMeasurer;
  let measureCalls: number;
  let lastMeasureInput: { html: string; templateId: string; density: string } | undefined;

  async function bootKernel(opts: { measurer?: ResumeLayoutMeasurer } = {}) {
    setupEnv();
    measureCalls = 0;
    lastMeasureInput = undefined;
    pdfRenderer = { async render(html: string) { return new FakePdfRenderer().render(html); } };
    measurer = opts.measurer ?? {
      async measure(input) {
        measureCalls += 1;
        lastMeasureInput = { html: input.html, templateId: input.templateId, density: input.density };
        return new HeuristicLayoutMeasurer().measure(input);
      },
    };
    kernel = await createKernel({ pdfRenderer, layoutMeasurer: measurer });
    server = await createServer(kernel);
  }

  beforeEach(async () => {
    await bootKernel();
  });

  afterEach(async () => {
    delete process.env.JOB_WORKER_ENABLED;
    delete process.env.PDF_RENDERER;
    delete process.env.FILE_STORAGE_PROVIDER;
    if (server) await server.close();
    if (kernel) await kernel.close();
  });

  it("attaches fitReport with all required fields after a PDF export completes", async () => {
    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "Fit Report PDF" });
    await kernel.productServices.resumeService.addResumeItem("user-1", resume.id, {
      title: "Senior Engineer",
      contentSnapshot: "Senior Engineer \u00B7 Acme \u00B7 2022 \u2013 2024\n- Built reliable systems\n- Cut p95 latency by 40%",
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
    expect(measureCalls).toBe(1);
    expect(lastMeasureInput?.templateId).toBe("one-page-modern");
    expect(lastMeasureInput?.density).toBe("standard");
    expect(lastMeasureInput?.html).toContain('data-template="one-page-modern"');

    const report = completed?.fitReport;
    expect(report).toBeDefined();
    expect(report?.targetPages).toBe(1);
    expect(report?.estimatedPages).toBeGreaterThanOrEqual(1);
    expect(report?.contentHeightPx).toBeGreaterThan(0);
    expect(report?.pageUsableHeightPx).toBeGreaterThan(0);
    expect(report?.templateId).toBe("one-page-modern");
    expect(report?.density).toBe("standard");
    expect(report?.measurer).toBe("heuristic");
    expect(report?.measuredAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    if ((report?.overflowPx ?? 0) === 0) {
      expect(report?.underflowPx).toBeGreaterThanOrEqual(0);
    } else {
      expect(report?.underflowPx).toBeUndefined();
    }
  });

  it("attaches fitReport on HTML exports as well as PDF exports", async () => {
    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "Fit Report HTML" });
    await kernel.productServices.resumeService.addResumeItem("user-1", resume.id, {
      title: "Engineer",
      contentSnapshot: "Engineer \u00B7 Beta \u00B7 2020 \u2013 2022\n- Shipped core API",
    });

    const created = await server.inject({
      method: "POST",
      url: `/exports/resumes/${resume.id}`,
      headers: { "x-user-id": "user-1", "content-type": "application/json" },
      payload: { format: "html", templateId: "one-page-modern" },
    });
    expect(created.statusCode).toBe(200);
    const data = (created.json() as ApiSuccess<{ exportRecord: ResumeExport; job: BackgroundJob }>).data;

    await kernel.jobRunner.runJob(data.job.id, "user-1");
    const completed = await kernel.exportService.getExport("user-1", data.exportRecord.id);
    expect(completed?.status).toBe("completed");
    expect(completed?.fitReport).toBeDefined();
    expect(completed?.fitReport?.templateId).toBe("one-page-modern");
  });

  it("does NOT fail the export when the resume overflows one A4 page (Phase 5 warn-only)", async () => {
    const overflowMeasurer: ResumeLayoutMeasurer = {
      async measure(): Promise<ResumeLayoutMeasurement> {
        return { contentHeightPx: 3000, pageUsableHeightPx: 987, measurer: "heuristic" };
      },
    };
    await server.close();
    await kernel.close();
    await bootKernel({ measurer: overflowMeasurer });

    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "Overflow Resume" });
    await kernel.productServices.resumeService.addResumeItem("user-1", resume.id, {
      title: "Engineer",
      contentSnapshot: "Engineer \u00B7 Beta \u00B7 2020 \u2013 2022\n- Single bullet",
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
    expect(completed?.fileId).toEqual(expect.any(String));
    const report = completed?.fitReport;
    expect(report?.estimatedPages).toBeGreaterThan(1);
    expect(report?.overflowPx).toBeGreaterThan(0);
    expect(report?.underflowPx).toBeUndefined();
  });

  it("completes the export even when the measurer throws (warning only, no fitReport)", async () => {
    const errorMeasurer: ResumeLayoutMeasurer = {
      async measure() {
        throw new Error("simulated measurer failure");
      },
    };
    await server.close();
    await kernel.close();
    await bootKernel({ measurer: errorMeasurer });

    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "Measurer broken" });
    await kernel.productServices.resumeService.addResumeItem("user-1", resume.id, {
      title: "Engineer",
      contentSnapshot: "One bullet only.",
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
    expect(completed?.fileId).toEqual(expect.any(String));
    expect(completed?.fitReport).toBeUndefined();
  });

  it("uses HeuristicLayoutMeasurer by default when no measurer is injected (no Chromium needed)", async () => {
    await server.close();
    await kernel.close();
    setupEnv();
    pdfRenderer = { async render(html: string) { return new FakePdfRenderer().render(html); } };
    kernel = await createKernel({ pdfRenderer });
    server = await createServer(kernel);

    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "Default measurer" });
    await kernel.productServices.resumeService.addResumeItem("user-1", resume.id, {
      title: "Engineer",
      contentSnapshot: "Engineer \u00B7 Beta \u00B7 2020 \u2013 2022\n- One bullet",
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
    expect(completed?.fitReport?.measurer).toBe("heuristic");
  });
});
