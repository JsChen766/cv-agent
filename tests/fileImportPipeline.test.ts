import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/api/createServer.js";
import { createKernel } from "../src/api/kernel/createKernel.js";
import type { ApiSuccess } from "../src/api/response.js";
import type { ApiKernel } from "../src/api/types.js";
import type { BackgroundJob } from "../src/platform/index.js";
import type { ProductImportCandidate, ProductImportJob } from "../src/product/types.js";
import type { UploadedFile } from "../src/files/types.js";
import { buildResumeImportDrafts } from "../src/product/services/index.js";

function setupEnv() {
  process.env.AUTH_MODE = "dev_header";
  process.env.AGENT_PROVIDER = "mock";
  process.env.NODE_ENV = "test";
  process.env.JOB_WORKER_ENABLED = "false";
  process.env.FILE_STORAGE_PROVIDER = "memory";
  delete process.env.DATABASE_URL;
}

describe("file upload → resume import pipeline", () => {
  let kernel: ApiKernel;
  let server: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    setupEnv();
    kernel = await createKernel();
    server = await createServer(kernel);
  });

  afterEach(async () => {
    delete process.env.JOB_WORKER_ENABLED;
    delete process.env.FILE_STORAGE_PROVIDER;
    await server.close();
    await kernel.close();
  });

  async function uploadTextFile(buffer: Buffer | string, mimeType = "text/plain", fileName = "resume.txt"): Promise<UploadedFile> {
    const base64 = (Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer, "utf8")).toString("base64");
    const response = await server.inject({
      method: "POST",
      url: "/files/upload",
      headers: { "x-user-id": "user-1", "content-type": "application/json" },
      payload: { fileName, mimeType, base64 },
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as ApiSuccess<UploadedFile>).data;
  }

  const chineseResumeText = [
    "张三",
    "教育经历",
    "2020.09-2024.06 香港科技大学 计算机科学 本科 GPA 3.8/4.0",
    "",
    "实习经历",
    "2023.06-2023.09 腾讯科技有限公司 数据分析实习生",
    "负责用户增长看板和 SQL 数据分析，将日报生成时间从 2 小时缩短到 15 分钟。",
    "",
    "项目经历",
    "项目一：智能简历解析系统",
    "2023.10-2024.01 角色：负责人",
    "使用 TypeScript、Node 和 PostgreSQL 设计上传解析链路，支持 PDF/DOCX/TXT。",
    "项目二：校园二手交易平台",
    "2022.03-2022.06 角色：后端开发者",
    "使用 Python 和 Vue 实现商品发布、搜索和订单管理。",
    "",
    "获奖经历",
    "2023 校级一等奖学金",
    "",
    "技能栈",
    "TypeScript, JavaScript, Vue, React, Node, Python, SQL, Docker",
  ].join("\n");

  it("splits a complete Chinese resume into multiple import drafts", () => {
    const drafts = buildResumeImportDrafts(chineseResumeText);

    expect(drafts.length).toBeGreaterThanOrEqual(5);
    expect(drafts.map((draft) => draft.category)).toEqual(expect.arrayContaining([
      "education",
      "internship",
      "project",
      "award",
      "skill",
    ]));
    expect(drafts.filter((draft) => draft.category === "project")).toHaveLength(2);
  });

  it("uploads a text resume, runs the import_resume_file job, and returns candidates", async () => {
    const resumeText = [
      "Project: Built analytics dashboard.",
      "Reduced query latency by 35%.",
      "",
      "Project: Designed onboarding flow.",
      "Improved activation by 18%.",
    ].join("\n");
    const file = await uploadTextFile(resumeText);
    expect(file.id).toMatch(/^file-/);
    expect(file.mimeType).toBe("text/plain");

    const importStarted = await server.inject({
      method: "POST",
      url: "/product/imports/file",
      headers: { "x-user-id": "user-1", "content-type": "application/json" },
      payload: { fileId: file.id },
    });
    expect(importStarted.statusCode).toBe(200);
    const startData = (importStarted.json() as ApiSuccess<{ job: BackgroundJob }>).data;
    expect(startData.job.type).toBe("import_resume_file");

    await kernel.jobRunner.runJob(startData.job.id, "user-1");

    const job = await kernel.platformServices.backgroundJobs.getJob("user-1", startData.job.id);
    expect(job?.status).toBe("completed");
    expect(job?.output?.importJobId).toEqual(expect.any(String));
    expect((job?.output as { candidateCount?: number })?.candidateCount ?? 0).toBeGreaterThan(0);

    const importJobId = (job?.output as { importJobId: string }).importJobId;
    const detail = await server.inject({
      method: "GET",
      url: `/product/imports/${importJobId}`,
      headers: { "x-user-id": "user-1" },
    });
    expect(detail.statusCode).toBe(200);
    const detailData = (detail.json() as ApiSuccess<{ job: ProductImportJob; candidates: ProductImportCandidate[] }>).data;
    expect(detailData.job.id).toBe(importJobId);
    expect(detailData.candidates.length).toBeGreaterThan(0);
    for (const candidate of detailData.candidates) {
      expect(candidate.title).toEqual(expect.any(String));
      expect(candidate.category).toEqual(expect.any(String));
      expect(candidate.content).toEqual(expect.any(String));
      expect(candidate.status).toBe("pending");
    }
  });

  it("imports a complete Chinese resume text file as multiple candidates", async () => {
    const file = await uploadTextFile(chineseResumeText, "text/plain", "完整中文简历.txt");
    const importStarted = await server.inject({
      method: "POST",
      url: "/product/imports/file",
      headers: { "x-user-id": "user-1", "content-type": "application/json" },
      payload: { fileId: file.id },
    });
    expect(importStarted.statusCode).toBe(200);
    const startData = (importStarted.json() as ApiSuccess<{ job: BackgroundJob }>).data;

    await kernel.jobRunner.runJob(startData.job.id, "user-1");

    const job = await kernel.platformServices.backgroundJobs.getJob("user-1", startData.job.id);
    expect(job?.status).toBe("completed");
    expect((job?.output as { candidateCount?: number })?.candidateCount ?? 0).toBeGreaterThan(1);
    expect((job?.output as { parsedDocumentId?: string })?.parsedDocumentId).toEqual(expect.any(String));
  });

  it("falls back to resume section splitting when the LLM returns one merged candidate", async () => {
    (kernel.productServices.importService as unknown as { llmExtractor: unknown }).llmExtractor = {
      extractCandidates: async () => [{
        type: "work",
        title: "整份简历",
        company: "多个组织",
        content: chineseResumeText,
        confidence: 0.7,
      }],
    };

    const job = await kernel.productServices.importService.createTextImportJob("user-1", chineseResumeText);
    const candidates = await kernel.productServices.importService.createCandidatesFromText("user-1", job.id);

    expect(candidates.length).toBeGreaterThan(1);
    expect(candidates.map((candidate) => candidate.category)).toEqual(expect.arrayContaining([
      "education",
      "internship",
      "project",
      "award",
      "skill",
    ]));
  });

  it("returns 404 when /product/imports/file is called with a missing fileId", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/product/imports/file",
      headers: { "x-user-id": "user-1", "content-type": "application/json" },
      payload: { fileId: "file-does-not-exist" },
    });
    expect(response.statusCode).toBe(404);
    const body = response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("rejects unsupported mime types with a clear 400", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/files/upload",
      headers: { "x-user-id": "user-1", "content-type": "application/json" },
      payload: {
        fileName: "shady.exe",
        mimeType: "application/octet-stream",
        base64: Buffer.from("not a resume", "utf8").toString("base64"),
      },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INVALID_BODY");
    expect(body.error.message.toLowerCase()).toMatch(/unsupported|file type/);
  });

  it("rejects empty file uploads", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/files/upload",
      headers: { "x-user-id": "user-1", "content-type": "application/json" },
      payload: {
        fileName: "empty.txt",
        mimeType: "text/plain",
        base64: "",
      },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INVALID_BODY");
  });

  it("fails the import job with a clear error when the file is empty", async () => {
    // Upload a tiny file that decodes to a single non-printable byte so the
    // size check passes but parsed text is effectively empty after trim.
    const file = await uploadTextFile(Buffer.from([0x20]));
    const importStarted = await server.inject({
      method: "POST",
      url: "/product/imports/file",
      headers: { "x-user-id": "user-1", "content-type": "application/json" },
      payload: { fileId: file.id },
    });
    const startData = (importStarted.json() as ApiSuccess<{ job: BackgroundJob }>).data;
    // Job retries up to maxAttempts; drive it to a terminal state in the test.
    for (let i = 0; i < startData.job.maxAttempts + 1; i += 1) {
      await kernel.jobRunner.runJob(startData.job.id, "user-1");
      const current = await kernel.platformServices.backgroundJobs.getJob("user-1", startData.job.id);
      if (current?.status === "failed" || current?.status === "completed") break;
    }
    const job = await kernel.platformServices.backgroundJobs.getJob("user-1", startData.job.id);
    expect(job?.status).toBe("failed");
    expect(job?.errorMessage ?? "").toMatch(/empty|extractable/i);
  });

  it("accepts multipart/form-data uploads with binary content", async () => {
    const boundary = "----CooltoTestBoundary";
    const fileBytes = Buffer.from("Multipart resume body.\nProject: Demo.", "utf8");
    const headerLines = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="resume.txt"',
      "Content-Type: text/plain",
      "",
      "",
    ].join("\r\n");
    const trailer = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    const payload = Buffer.concat([Buffer.from(headerLines, "utf8"), fileBytes, trailer]);
    const response = await server.inject({
      method: "POST",
      url: "/files/upload",
      headers: {
        "x-user-id": "user-1",
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(response.statusCode).toBe(200);
    const data = (response.json() as ApiSuccess<UploadedFile>).data;
    expect(data.mimeType).toBe("text/plain");
    expect(data.originalName).toBe("resume.txt");
    expect(data.sizeBytes).toBe(fileBytes.length);
  });

  it("accepts an import candidate and creates a ProductExperience", async () => {
    const file = await uploadTextFile("Built analytics dashboard. Reduced query latency by 35%.");
    const importStarted = await server.inject({
      method: "POST",
      url: "/product/imports/file",
      headers: { "x-user-id": "user-1", "content-type": "application/json" },
      payload: { fileId: file.id },
    });
    const startData = (importStarted.json() as ApiSuccess<{ job: BackgroundJob }>).data;
    await kernel.jobRunner.runJob(startData.job.id, "user-1");
    const job = await kernel.platformServices.backgroundJobs.getJob("user-1", startData.job.id);
    const importJobId = (job?.output as { importJobId: string }).importJobId;

    const detail = await server.inject({
      method: "GET",
      url: `/product/imports/${importJobId}`,
      headers: { "x-user-id": "user-1" },
    });
    const candidate = (detail.json() as ApiSuccess<{ candidates: ProductImportCandidate[] }>).data.candidates[0];
    expect(candidate).toBeDefined();

    const accept = await server.inject({
      method: "POST",
      url: `/product/import-candidates/${candidate.id}/accept`,
      headers: { "x-user-id": "user-1", "content-type": "application/json" },
      payload: {},
    });
    expect(accept.statusCode).toBe(200);
    const experiences = await kernel.productServices.experienceService.listExperiences("user-1");
    expect(experiences.length).toBeGreaterThan(0);
  });
});
