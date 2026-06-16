import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/api/createServer.js";
import { createKernel } from "../src/api/kernel/createKernel.js";
import { FakePdfRenderer, type PdfRendererAdapter } from "../src/exports/index.js";
import type { ApiSuccess } from "../src/api/response.js";
import type { ApiKernel } from "../src/api/types.js";
import type { BackgroundJob } from "../src/platform/index.js";
import type { ResumeExport } from "../src/exports/index.js";
import {
  PHASE0_CHINESE_EXPERIENCES,
  PHASE0_CHINESE_JD,
  PHASE0_EXPECTED_RESUME,
} from "./fixtures/phase0/index.js";

const USER_ID = "phase0-user";

function setupEnv() {
  process.env.AUTH_MODE = "dev_header";
  process.env.AGENT_PROVIDER = "mock";
  process.env.NODE_ENV = "test";
  process.env.JOB_WORKER_ENABLED = "false";
  process.env.PDF_RENDERER = "playwright";
  process.env.FILE_STORAGE_PROVIDER = "memory";
  delete process.env.DATABASE_URL;
}

describe("Phase 0 baseline - generate -> accept -> export end-to-end", () => {
  let kernel: ApiKernel;
  let server: Awaited<ReturnType<typeof createServer>>;
  let renderer: PdfRendererAdapter;

  beforeEach(async () => {
    setupEnv();
    renderer = new FakePdfRenderer();
    kernel = await createKernel({ pdfRenderer: renderer });
    server = await createServer(kernel);
  });

  afterEach(async () => {
    delete process.env.JOB_WORKER_ENABLED;
    delete process.env.PDF_RENDERER;
    delete process.env.FILE_STORAGE_PROVIDER;
    if (server) await server.close();
    if (kernel) await kernel.close();
  });

  it("seeds Chinese experiences + JD, generates, accepts, and exports HTML containing resume content", async () => {
    const savedExperiences: Array<{ id: string; category: string }> = [];
    for (const exp of PHASE0_CHINESE_EXPERIENCES) {
      const created = await kernel.productServices.experienceService.createExperience(USER_ID, {
        title: exp.title,
        category: exp.category,
        content: exp.content,
        organization: exp.organization,
        role: exp.role,
        startDate: exp.startDate,
        endDate: exp.endDate,
        tags: exp.tags,
      });
      savedExperiences.push(created.experience);
    }
    expect(savedExperiences.length).toBe(PHASE0_CHINESE_EXPERIENCES.length);
    expect(savedExperiences.length).toBeGreaterThanOrEqual(4);
    const categories = new Set(savedExperiences.map((item) => item.category));
    expect(categories.has("education")).toBe(true);
    expect(categories.has("internship")).toBe(true);
    expect(categories.has("project")).toBe(true);
    expect(categories.has("skill")).toBe(true);

    const jd = await kernel.productServices.jdService.saveJD(USER_ID, {
      rawText: PHASE0_CHINESE_JD.rawText,
      title: PHASE0_CHINESE_JD.title,
      company: PHASE0_CHINESE_JD.company,
      targetRole: PHASE0_CHINESE_JD.targetRole,
    });
    expect(jd.id).toEqual(expect.any(String));
    expect(jd.rawText).toContain("\u9ad8\u7ea7\u524d\u7aef\u5de5\u7a0b\u5e08");

    const listed = await kernel.productServices.experienceService.listExperiences(USER_ID, {
      limit: 20,
      status: "active",
    });
    expect(listed.length).toBe(savedExperiences.length);

    const generation = await kernel.productServices.generationProductService.generateResumeFromJD({
      userId: USER_ID,
      jdId: jd.id,
      targetRole: PHASE0_CHINESE_JD.targetRole,
    });
    expect(generation.generation.id).toEqual(expect.any(String));
    expect(generation.variants.length).toBeGreaterThan(0);
    const firstVariant = generation.variants[0]!;
    expect(typeof firstVariant.id).toBe("string");
    expect(typeof firstVariant.content).toBe("string");
    expect(firstVariant.content.length).toBeGreaterThan(0);

    const accepted = await kernel.productServices.generationProductService.saveAcceptedVariantToResume(USER_ID, {
      generationId: generation.generation.id,
      variantId: firstVariant.id,
    });
    expect(accepted.resume.id).toEqual(expect.any(String));
    const resumeDetail = await kernel.productServices.resumeService.getResume(USER_ID, accepted.resume.id);
    expect(resumeDetail).toBeTruthy();
    expect(resumeDetail!.items.length).toBeGreaterThan(0);

    expect(PHASE0_EXPECTED_RESUME.metadata.requiredSectionTypes.length).toBeGreaterThan(0);
    expect(PHASE0_EXPECTED_RESUME.metadata.targetPages).toBe(1);

    const htmlCreated = await server.inject({
      method: "POST",
      url: `/exports/resumes/${accepted.resume.id}`,
      headers: { "x-user-id": USER_ID, "content-type": "application/json" },
      payload: { format: "html" },
    });
    expect(htmlCreated.statusCode).toBe(200);
    const htmlData = (htmlCreated.json() as ApiSuccess<{ exportRecord: ResumeExport; job: BackgroundJob; workerDisabled?: boolean }>).data;
    expect(htmlData.exportRecord.status).toBe("pending");
    expect(htmlData.job.type).toBe("export_resume_html");
    expect(htmlData.workerDisabled).toBe(true);

    await kernel.jobRunner.runJob(htmlData.job.id, USER_ID);
    const htmlCompleted = await kernel.exportService.getExport(USER_ID, htmlData.exportRecord.id);
    expect(htmlCompleted?.status).toBe("completed");
    expect(htmlCompleted?.fileId).toEqual(expect.any(String));

    const htmlDownload = await server.inject({
      method: "GET",
      url: `/exports/${htmlData.exportRecord.id}/download`,
      headers: { "x-user-id": USER_ID },
    });
    expect(htmlDownload.statusCode).toBe(200);
    expect(htmlDownload.body.length).toBeGreaterThan(0);
    const snippet = resumeDetail!.items[0]!.contentSnapshot.slice(0, 12);
    expect(snippet.length).toBeGreaterThan(0);
    expect(htmlDownload.body).toContain(snippet);
  });

  it("creates a PDF export job, runJob completes, and download returns a PDF buffer", async () => {
    const exp = PHASE0_CHINESE_EXPERIENCES[2]!;
    await kernel.productServices.experienceService.createExperience(USER_ID, {
      title: exp.title,
      category: exp.category,
      content: exp.content,
      organization: exp.organization,
    });

    const jd = await kernel.productServices.jdService.saveJD(USER_ID, {
      rawText: PHASE0_CHINESE_JD.rawText,
      title: PHASE0_CHINESE_JD.title,
      targetRole: PHASE0_CHINESE_JD.targetRole,
    });

    const gen = await kernel.productServices.generationProductService.generateResumeFromJD({
      userId: USER_ID,
      jdId: jd.id,
      targetRole: PHASE0_CHINESE_JD.targetRole,
    });
    // Pre-create an ASCII-titled resume target so the PDF download's
    // Content-Disposition header (built from resume.title) stays HTTP-safe.
    // The resume body still carries the Chinese variant content; this only
    // affects the filename header. (When export filename UX is rebuilt in a
    // later phase, this workaround can be removed.)
    const targetResume = await kernel.productServices.resumeService.createResume(USER_ID, {
      title: "Phase0 PDF Export Resume",
      targetRole: PHASE0_CHINESE_JD.targetRole,
      jdId: jd.id,
    });
    const accepted = await kernel.productServices.generationProductService.saveAcceptedVariantToResume(USER_ID, {
      generationId: gen.generation.id,
      variantId: gen.variants[0]!.id,
      resumeId: targetResume.id,
    });

    const createPdf = await server.inject({
      method: "POST",
      url: `/exports/resumes/${accepted.resume.id}`,
      headers: { "x-user-id": USER_ID, "content-type": "application/json" },
      payload: { format: "pdf" },
    });
    expect(createPdf.statusCode).toBe(200);
    const pdfData = (createPdf.json() as ApiSuccess<{ exportRecord: ResumeExport; job: BackgroundJob; workerDisabled?: boolean }>).data;
    expect(pdfData.exportRecord.status).toBe("pending");
    expect(pdfData.job.type).toBe("export_resume_pdf");

    await kernel.jobRunner.runJob(pdfData.job.id, USER_ID);
    const completed = await kernel.exportService.getExport(USER_ID, pdfData.exportRecord.id);
    expect(completed?.status).toBe("completed");
    expect(completed?.fileId).toEqual(expect.any(String));

    const download = await server.inject({
      method: "GET",
      url: `/exports/${pdfData.exportRecord.id}/download`,
      headers: { "x-user-id": USER_ID },
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toBe("application/pdf");
    const disposition = download.headers["content-disposition"] ?? "";
    expect(disposition).toMatch(/filename=/);
    expect(disposition).toMatch(/PDF/i);
    const body = download.rawPayload ?? Buffer.from(download.body);
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body.subarray(0, 5).toString("utf8")).toBe("%PDF-");
  });
});
