import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/api/createServer.js";
import { createKernel } from "../src/api/kernel/createKernel.js";
import type { ApiSuccess } from "../src/api/response.js";
import type { ApiKernel } from "../src/api/types.js";

function setupEnv() {
  process.env.AUTH_MODE = "dev_header";
  process.env.AGENT_PROVIDER = "mock";
  process.env.FRONTDESK_AGENT_MODE = "mock";
  process.env.EXPERIENCE_EXTRACTOR_MODE = "deterministic";
  process.env.ARTIFACT_GENERATOR_MODE = "deterministic";
  process.env.CRITIC_AGENT_MODE = "deterministic";
  process.env.REVISION_AGENT_MODE = "deterministic";
  process.env.NODE_ENV = "test";
  delete process.env.DATABASE_URL;
}

describe("Product API routes", () => {
  let kernel: ApiKernel;
  let server: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    setupEnv();
    kernel = await createKernel();
    server = await createServer(kernel);
  });

  afterEach(async () => {
    await server.close();
    await kernel.close();
  });

  it("creates and lists experiences scoped to authenticated user", async () => {
    const created = await server.inject({
      method: "POST",
      url: "/product/experiences",
      headers: { "x-user-id": "user-1" },
      payload: { title: "React systems", content: "Built React and TypeScript systems." },
    });
    expect(created.statusCode).toBe(200);

    const own = await server.inject({ method: "GET", url: "/product/experiences", headers: { "x-user-id": "user-1" } });
    const other = await server.inject({ method: "GET", url: "/product/experiences", headers: { "x-user-id": "user-2" } });
    expect((own.json() as ApiSuccess<unknown[]>).data.length).toBe(1);
    expect((other.json() as ApiSuccess<unknown[]>).data.length).toBe(0);
  });

  it("saves and lists JDs scoped to authenticated user", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/product/jds",
      headers: { "x-user-id": "user-1" },
      payload: { rawText: "React performance role.", targetRole: "FE" },
    });
    expect(response.statusCode).toBe(200);
    const list = await server.inject({ method: "GET", url: "/product/jds", headers: { "x-user-id": "user-1" } });
    expect((list.json() as ApiSuccess<unknown[]>).data.length).toBe(1);
  });

  it("creates resumes and item snapshots", async () => {
    const resumeResponse = await server.inject({
      method: "POST",
      url: "/product/resumes",
      headers: { "x-user-id": "user-1" },
      payload: { title: "FE draft", targetRole: "FE" },
    });
    const resume = (resumeResponse.json() as ApiSuccess<{ id: string }>).data;
    const itemResponse = await server.inject({
      method: "POST",
      url: `/product/resumes/${resume.id}/items`,
      headers: { "x-user-id": "user-1" },
      payload: { title: "React performance", contentSnapshot: "Reduced bundle size by 40%." },
    });
    expect(itemResponse.statusCode).toBe(200);
    expect((itemResponse.json() as ApiSuccess<{ contentSnapshot: string }>).data.contentSnapshot).toContain("40%");
  });

  it("patches resume items without clearing omitted fields", async () => {
    const resumeResponse = await server.inject({
      method: "POST",
      url: "/product/resumes",
      headers: { "x-user-id": "user-1" },
      payload: { title: "FE draft" },
    });
    const resume = (resumeResponse.json() as ApiSuccess<{ id: string }>).data;
    const itemResponse = await server.inject({
      method: "POST",
      url: `/product/resumes/${resume.id}/items`,
      headers: { "x-user-id": "user-1" },
      payload: { title: "Original title", contentSnapshot: "Original content." },
    });
    const item = (itemResponse.json() as ApiSuccess<{ id: string }>).data;

    const patched = await server.inject({
      method: "PATCH",
      url: `/product/resume-items/${item.id}`,
      headers: { "x-user-id": "user-1" },
      payload: { pinned: true, contentSnapshot: "Updated content." },
    });

    expect(patched.statusCode).toBe(200);
    expect((patched.json() as ApiSuccess<{ title: string; contentSnapshot: string; pinned: boolean }>).data).toMatchObject({
      title: "Original title",
      contentSnapshot: "Updated content.",
      pinned: true,
    });
  });

  it("rejects null title when patching resume items", async () => {
    const resumeResponse = await server.inject({
      method: "POST",
      url: "/product/resumes",
      headers: { "x-user-id": "user-1" },
      payload: { title: "FE draft" },
    });
    const resume = (resumeResponse.json() as ApiSuccess<{ id: string }>).data;
    const itemResponse = await server.inject({
      method: "POST",
      url: `/product/resumes/${resume.id}/items`,
      headers: { "x-user-id": "user-1" },
      payload: { title: "Original title", contentSnapshot: "Original content." },
    });
    const item = (itemResponse.json() as ApiSuccess<{ id: string }>).data;

    const patched = await server.inject({
      method: "PATCH",
      url: `/product/resume-items/${item.id}`,
      headers: { "x-user-id": "user-1" },
      payload: { title: null, pinned: true },
    });

    expect(patched.statusCode).toBe(400);
    expect(patched.json()).toMatchObject({
      ok: false,
      error: { code: "INVALID_BODY", message: "title must be a non-empty string when provided." },
    });
  });

  it("queues text import, completes candidates in a background job, and accepts a candidate", async () => {
    const importResponse = await server.inject({
      method: "POST",
      url: "/product/imports/text",
      headers: { "x-user-id": "user-1" },
      payload: { rawText: "Built React systems.\n\nReduced bundle size." },
    });
    const data = (importResponse.json() as ApiSuccess<{
      job: { id: string; status: string };
      importJobId: string;
      jobId: string;
      backgroundJob: { id: string; type: string; status: string };
      candidates: Array<{ id: string }>;
    }>).data;
    expect(data.job.id).toBe(data.importJobId);
    expect(data.job.status).toBe("pending");
    expect(data.backgroundJob.id).toBe(data.jobId);
    expect(data.backgroundJob.type).toBe("import_resume_text");
    expect(data.candidates).toEqual([]);

    await kernel.jobRunner.runJob(data.jobId, "user-1");
    const detail = await server.inject({ method: "GET", url: `/product/imports/${data.importJobId}`, headers: { "x-user-id": "user-1" } });
    const detailData = (detail.json() as ApiSuccess<{ candidates: Array<{ id: string }> }>).data;
    expect(detailData.candidates.length).toBeGreaterThan(0);

    const accept = await server.inject({
      method: "POST",
      url: `/product/import-candidates/${detailData.candidates[0]!.id}/accept`,
      headers: { "x-user-id": "user-1" },
    });
    expect(accept.statusCode).toBe(200);
  });

  it("does not extract text import candidates during the request", async () => {
    let extractionCalls = 0;
    kernel.productServices.importService.createCandidatesFromText = async () => {
      extractionCalls += 1;
      throw new Error("extraction should run in a background job");
    };

    const importResponse = await server.inject({
      method: "POST",
      url: "/product/imports/text",
      headers: { "x-user-id": "user-1" },
      payload: { rawText: "Built React systems." },
    });

    expect(importResponse.statusCode).toBe(200);
    expect(extractionCalls).toBe(0);
  });

  it("accepts an import candidate with edited fields", async () => {
    const importResponse = await server.inject({
      method: "POST",
      url: "/product/imports/text",
      headers: { "x-user-id": "user-1" },
      payload: { rawText: "WEEX Data Analyst Intern. Built SQL dashboards." },
    });
    const queued = (importResponse.json() as ApiSuccess<{ importJobId: string; jobId: string }>).data;
    await kernel.jobRunner.runJob(queued.jobId, "user-1");
    const detail = await server.inject({ method: "GET", url: `/product/imports/${queued.importJobId}`, headers: { "x-user-id": "user-1" } });
    const data = (detail.json() as ApiSuccess<{ candidates: Array<{ id: string }> }>).data;
    const accept = await server.inject({
      method: "POST",
      url: `/product/import-candidates/${data.candidates[0]!.id}/accept`,
      headers: { "x-user-id": "user-1" },
      payload: {
        title: "Edited Internship",
        category: "internship",
        organization: "Edited Company",
        role: "Data Analyst Intern",
        startDate: "2025-01",
        endDate: "2025-04",
        content: "Edited work content.",
        structured: { company: "Edited Company", highlights: ["Edited work content."] },
      },
    });
    expect(accept.statusCode).toBe(200);
    const accepted = (accept.json() as ApiSuccess<{ candidate: { status: string }; experience: { id: string; title: string; organization?: string } }>).data;
    expect(accepted.candidate.status).toBe("accepted");
    expect(accepted.experience.title).toBe("Edited Internship");
    expect(accepted.experience.organization).toBe("Edited Company");
  });

  it("queues generation from JD and completes variants in a background job", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/product/generations/from-jd",
      headers: { "x-user-id": "user-1" },
      payload: { jdText: "React TypeScript performance optimization role.", targetRole: "Frontend Engineer" },
    });
    const data = (response.json() as ApiSuccess<{ job: { id: string; type: string; status: string }; jobId: string; actionType: string }>).data;
    expect(response.statusCode).toBe(200);
    expect(data.job.id).toBe(data.jobId);
    expect(data.job.type).toBe("long_generation");
    expect(data.actionType).toBe("generate_resume_from_jd");

    await kernel.jobRunner.runJob(data.jobId, "user-1");
    const job = await kernel.platformServices.backgroundJobs.getJob("user-1", data.jobId);
    expect(job?.status).toBe("completed");
    const generationId = job?.output?.generationId as string;
    expect(generationId).toMatch(/^pgen-/);
    expect(job?.output?.variantCount).toBeGreaterThan(0);
  });

  it("lists product generations and dashboard read model user-scoped", async () => {
    const created = await server.inject({
      method: "POST",
      url: "/product/generations/from-jd",
      headers: { "x-user-id": "user-1" },
      payload: { jdText: "React TypeScript performance optimization role.", targetRole: "Frontend Engineer" },
    });
    const queued = (created.json() as ApiSuccess<{ jobId: string }>).data;
    await kernel.jobRunner.runJob(queued.jobId, "user-1");
    const job = await kernel.platformServices.backgroundJobs.getJob("user-1", queued.jobId);
    const generationId = job?.output?.generationId as string;

    const ownList = await server.inject({ method: "GET", url: "/product/generations", headers: { "x-user-id": "user-1" } });
    const otherList = await server.inject({ method: "GET", url: "/product/generations", headers: { "x-user-id": "user-2" } });
    expect((ownList.json() as ApiSuccess<unknown[]>).data.length).toBe(1);
    expect((otherList.json() as ApiSuccess<unknown[]>).data.length).toBe(0);

    const detail = await server.inject({ method: "GET", url: `/product/generations/${generationId}`, headers: { "x-user-id": "user-1" } });
    const otherDetail = await server.inject({ method: "GET", url: `/product/generations/${generationId}`, headers: { "x-user-id": "user-2" } });
    expect(detail.statusCode).toBe(200);
    expect(otherDetail.statusCode).toBe(404);

    const dashboard = await server.inject({ method: "GET", url: "/product/dashboard", headers: { "x-user-id": "user-1" } });
    const dashboardData = (dashboard.json() as ApiSuccess<{ generationCount: number; recentGenerations: unknown[] }>).data;
    expect(dashboardData.generationCount).toBe(1);
    expect(dashboardData.recentGenerations.length).toBe(1);
  });

  it("rejects invalid product enum values", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/product/experiences",
      headers: { "x-user-id": "user-1" },
      payload: { title: "Bad category", content: "Built systems.", category: "invalid" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      error: { code: "INVALID_BODY" },
    });
  });
});
