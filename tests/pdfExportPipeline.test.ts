import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/api/createServer.js";
import { createKernel } from "../src/api/kernel/createKernel.js";
import { FakePdfRenderer, type PdfRendererAdapter } from "../src/exports/index.js";
import type { ApiSuccess } from "../src/api/response.js";
import type { ApiKernel } from "../src/api/types.js";
import type { BackgroundJob } from "../src/platform/index.js";
import type { ResumeExport } from "../src/exports/index.js";

function setupEnv(pdfRenderer: "playwright" | "none" = "playwright") {
  process.env.AUTH_MODE = "dev_header";
  process.env.AGENT_PROVIDER = "mock";
  process.env.NODE_ENV = "test";
  process.env.JOB_WORKER_ENABLED = "false";
  process.env.PDF_RENDERER = pdfRenderer;
  process.env.FILE_STORAGE_PROVIDER = "memory";
  delete process.env.DATABASE_URL;
}

describe("resume export — PDF pipeline", () => {
  let kernel: ApiKernel;
  let server: Awaited<ReturnType<typeof createServer>>;
  let renderer: PdfRendererAdapter;
  let renderCalls: number;

  async function bootKernel(opts: { renderer?: PdfRendererAdapter; pdfRenderer?: "playwright" | "none" } = {}) {
    setupEnv(opts.pdfRenderer ?? "playwright");
    renderCalls = 0;
    renderer = opts.renderer ?? {
      async render(html) {
        renderCalls += 1;
        return new FakePdfRenderer().render(html);
      },
    };
    kernel = await createKernel({ pdfRenderer: renderer });
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

  it("creates a pdf export, renders it via the injected adapter, and returns a binary buffer on download", async () => {
    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "PDF resume" });
    await kernel.productServices.resumeService.addResumeItem("user-1", resume.id, {
      title: "Highlights",
      contentSnapshot: "Built reliable PDF export pipeline.",
    });

    const created = await server.inject({
      method: "POST",
      url: `/exports/resumes/${resume.id}`,
      headers: { "x-user-id": "user-1", "content-type": "application/json" },
      payload: { format: "pdf" },
    });
    expect(created.statusCode).toBe(200);
    const data = (created.json() as ApiSuccess<{ exportRecord: ResumeExport; job: BackgroundJob; workerDisabled?: boolean }>).data;
    expect(data.exportRecord.status).toBe("pending");
    expect(data.job.type).toBe("export_resume_pdf");
    expect(data.workerDisabled).toBe(true);

    await kernel.jobRunner.runJob(data.job.id, "user-1");

    const completed = await kernel.exportService.getExport("user-1", data.exportRecord.id);
    expect(completed?.status).toBe("completed");
    expect(completed?.fileId).toEqual(expect.any(String));
    expect(renderCalls).toBe(1);

    const download = await server.inject({
      method: "GET",
      url: `/exports/${data.exportRecord.id}/download`,
      headers: { "x-user-id": "user-1" },
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toBe("application/pdf");
    const disposition = download.headers["content-disposition"] ?? "";
    expect(disposition).toMatch(/filename=/);
    expect(disposition).toMatch(/PDF/i);
    // Body should be the PDF bytes (starting with `%PDF-`).
    const body = download.rawPayload ?? Buffer.from(download.body);
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.subarray(0, 5).toString("utf8")).toBe("%PDF-");
  });

  it("returns 503 when PDF_RENDERER=none and a pdf export is requested", async () => {
    await server.close();
    await kernel.close();
    await bootKernel({ pdfRenderer: "none" });

    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "PDF rejected" });
    const response = await server.inject({
      method: "POST",
      url: `/exports/resumes/${resume.id}`,
      headers: { "x-user-id": "user-1", "content-type": "application/json" },
      payload: { format: "pdf" },
    });
    expect(response.statusCode).toBe(503);
    const body = response.json() as { error: { code: string; message: string } };
    expect(body.error.message).toMatch(/PDF_RENDERER=playwright/i);
  });

  it("renderExportJob is idempotent — repeated calls do not produce a second file", async () => {
    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "Idempotent" });
    await kernel.productServices.resumeService.addResumeItem("user-1", resume.id, {
      title: "Section",
      contentSnapshot: "Idempotency check.",
    });
    const created = await server.inject({
      method: "POST",
      url: `/exports/resumes/${resume.id}`,
      headers: { "x-user-id": "user-1", "content-type": "application/json" },
      payload: { format: "pdf" },
    });
    const data = (created.json() as ApiSuccess<{ exportRecord: ResumeExport; job: BackgroundJob }>).data;

    await kernel.jobRunner.runJob(data.job.id, "user-1");
    const first = await kernel.exportService.getExport("user-1", data.exportRecord.id);
    expect(first?.status).toBe("completed");
    expect(renderCalls).toBe(1);
    const firstFileId = first?.fileId;

    // Calling renderExportJob again should be a no-op for already-completed exports.
    const second = await kernel.exportService.renderExportJob("user-1", data.exportRecord.id);
    expect(second.status).toBe("completed");
    expect(second.fileId).toBe(firstFileId);
    expect(renderCalls).toBe(1);
  });

  it("surfaces a clear error when the renderer adapter fails", async () => {
    await server.close();
    await kernel.close();
    await bootKernel({
      renderer: {
        async render() {
          throw new Error("Playwright Chromium is not installed or cannot start. Run: npx playwright install chromium");
        },
      },
    });
    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "Broken renderer" });
    await kernel.productServices.resumeService.addResumeItem("user-1", resume.id, {
      title: "Section",
      contentSnapshot: "Will not render.",
    });
    const created = await server.inject({
      method: "POST",
      url: `/exports/resumes/${resume.id}`,
      headers: { "x-user-id": "user-1", "content-type": "application/json" },
      payload: { format: "pdf" },
    });
    const data = (created.json() as ApiSuccess<{ exportRecord: ResumeExport; job: BackgroundJob }>).data;

    // Drive job to terminal failure
    for (let i = 0; i < data.job.maxAttempts + 1; i += 1) {
      await kernel.jobRunner.runJob(data.job.id, "user-1");
      const j = await kernel.platformServices.backgroundJobs.getJob("user-1", data.job.id);
      if (j?.status === "failed" || j?.status === "completed") break;
    }
    const failed = await kernel.exportService.getExport("user-1", data.exportRecord.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.errorMessage ?? "").toMatch(/Chromium/i);

    // Download must surface "not ready"
    const download = await server.inject({
      method: "GET",
      url: `/exports/${data.exportRecord.id}/download`,
      headers: { "x-user-id": "user-1" },
    });
    expect(download.statusCode).toBe(404);
  });
});
