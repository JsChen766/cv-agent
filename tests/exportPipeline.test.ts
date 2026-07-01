import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/api/createServer.js";
import { createKernel } from "../src/api/kernel/createKernel.js";
import type { ApiSuccess } from "../src/api/response.js";
import type { ApiKernel } from "../src/api/types.js";
import type { BackgroundJob } from "../src/platform/index.js";
import type { ResumeExport } from "../src/exports/index.js";

function setupEnv() {
  process.env.AUTH_MODE = "dev_header";
  process.env.AGENT_PROVIDER = "mock";
  process.env.NODE_ENV = "test";
  process.env.JOB_WORKER_ENABLED = "false";
  delete process.env.DATABASE_URL;
}

describe("resume export pipeline", () => {
  let kernel: ApiKernel;
  let server: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    setupEnv();
    kernel = await createKernel();
    server = await createServer(kernel);
  });

  afterEach(async () => {
    delete process.env.JOB_WORKER_ENABLED;
    await server.close();
    await kernel.close();
  });

  it("creates a pending export and job, then JobRunner completes it and download returns HTML", async () => {
    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "Export me" });
    await kernel.productServices.resumeService.addResumeItem("user-1", resume.id, {
      title: "Impact",
      contentSnapshot: "Improved hiring workflow reliability.",
    });

    const created = await server.inject({
      method: "POST",
      url: `/exports/resumes/${resume.id}`,
      headers: { "x-user-id": "user-1" },
      payload: { format: "html" },
    });

    expect(created.statusCode).toBe(200);
    const data = (created.json() as ApiSuccess<{ exportRecord: ResumeExport; job: BackgroundJob; workerDisabled?: boolean }>).data;
    expect(data.exportRecord.status).toBe("pending");
    expect(data.exportRecord.templateId).toBe("one-page-modern");
    expect(data.job.type).toBe("export_resume_html");
    expect(data.workerDisabled).toBe(true);

    await kernel.jobRunner.runJob(data.job.id, "user-1");

    const completed = await kernel.exportService.getExport("user-1", data.exportRecord.id);
    expect(completed?.status).toBe("completed");
    expect(completed?.fileId).toEqual(expect.any(String));

    const download = await server.inject({
      method: "GET",
      url: `/exports/${data.exportRecord.id}/download`,
      headers: { "x-user-id": "user-1" },
    });
    expect(download.statusCode).toBe(200);
    expect(download.body).toContain("Improved hiring workflow reliability.");
  });

  it("deletes exports idempotently without relaxing missing or cross-user access", async () => {
    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "Delete export" });
    const created = await server.inject({
      method: "POST",
      url: `/exports/resumes/${resume.id}`,
      headers: { "x-user-id": "user-1" },
      payload: { format: "html" },
    });
    const data = (created.json() as ApiSuccess<{ exportRecord: ResumeExport }>).data;

    const first = await server.inject({
      method: "DELETE",
      url: `/exports/${data.exportRecord.id}`,
      headers: { "x-user-id": "user-1" },
    });
    const second = await server.inject({
      method: "DELETE",
      url: `/exports/${data.exportRecord.id}`,
      headers: { "x-user-id": "user-1" },
    });
    const crossUser = await server.inject({
      method: "DELETE",
      url: `/exports/${data.exportRecord.id}`,
      headers: { "x-user-id": "user-2" },
    });
    const missing = await server.inject({
      method: "DELETE",
      url: "/exports/export-missing",
      headers: { "x-user-id": "user-1" },
    });

    expect(first.statusCode).toBe(200);
    expect((first.json() as ApiSuccess<ResumeExport>).data.status).toBe("deleted");
    expect(second.statusCode).toBe(200);
    expect((second.json() as ApiSuccess<ResumeExport>).data.status).toBe("deleted");
    expect(crossUser.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
  });

  it("marks the export failed when the export job cannot render", async () => {
    const created = await server.inject({
      method: "POST",
      url: "/exports/resumes/pres-missing",
      headers: { "x-user-id": "user-1" },
      payload: { format: "html" },
    });
    const data = (created.json() as ApiSuccess<{ exportRecord: ResumeExport; job: BackgroundJob }>).data;

    await kernel.jobRunner.runJob(data.job.id, "user-1");

    const failed = await kernel.exportService.getExport("user-1", data.exportRecord.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.errorMessage).toContain("Resume not found");
  });

  it("dev render fallback endpoint renders a pending export", async () => {
    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "Fallback export" });
    await kernel.productServices.resumeService.addResumeItem("user-1", resume.id, {
      title: "Fallback item",
      contentSnapshot: "Rendered by dev fallback.",
    });
    const created = await server.inject({
      method: "POST",
      url: `/exports/resumes/${resume.id}`,
      headers: { "x-user-id": "user-1" },
      payload: { format: "html" },
    });
    const data = (created.json() as ApiSuccess<{ exportRecord: ResumeExport }>).data;

    const rendered = await server.inject({
      method: "POST",
      url: `/exports/${data.exportRecord.id}/render`,
      headers: { "x-user-id": "user-1" },
      payload: {},
    });

    expect(rendered.statusCode).toBe(200);
    const record = (rendered.json() as ApiSuccess<ResumeExport>).data;
    expect(record.status).toBe("completed");
    expect(record.fileId).toEqual(expect.any(String));
  });

  it("defaults templateId to one-page-modern when not specified", async () => {
    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "Template test" });
    const created = await kernel.exportService.createExport("user-1", {
      resumeId: resume.id,
      format: "html",
    });
    expect(created.exportRecord.templateId).toBe("one-page-modern");
  });

  it("respects explicit templateId override", async () => {
    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "Override test" });
    const created = await kernel.exportService.createExport("user-1", {
      resumeId: resume.id,
      format: "html",
      templateId: "default",
    });
    expect(created.exportRecord.templateId).toBe("default");
  });

  it("respects DEFAULT_RESUME_TEMPLATE env override", async () => {
    process.env.DEFAULT_RESUME_TEMPLATE = "default";
    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "Env override test" });
    const created = await kernel.exportService.createExport("user-1", {
      resumeId: resume.id,
      format: "html",
    });
    expect(created.exportRecord.templateId).toBe("default");
    delete process.env.DEFAULT_RESUME_TEMPLATE;
  });
});
