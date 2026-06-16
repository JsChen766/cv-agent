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

function setupEnv() {
  process.env.AUTH_MODE = "dev_header";
  process.env.AGENT_PROVIDER = "mock";
  process.env.NODE_ENV = "test";
  process.env.JOB_WORKER_ENABLED = "false";
  process.env.PDF_RENDERER = "playwright";
  process.env.FILE_STORAGE_PROVIDER = "memory";
  delete process.env.DATABASE_URL;
}

describe("Phase 8 resume quality pipeline — qualityReport persisted on export", () => {
  let kernel: ApiKernel;
  let server: Awaited<ReturnType<typeof createServer>>;
  let pdfRenderer: PdfRendererAdapter;

  async function bootKernel(measurer: ResumeLayoutMeasurer) {
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

  it("persists a qualityReport with all dimensions and never blocks the export", async () => {
    const measurer: ResumeLayoutMeasurer = {
      async measure(): Promise<ResumeLayoutMeasurement> {
        return { contentHeightPx: 850, pageUsableHeightPx: 987, measurer: "heuristic" };
      },
    };
    await bootKernel(measurer);

    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "Phase8 Quality" });
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
    expect(completed?.fileId).toEqual(expect.any(String));
    const quality = completed?.qualityReport;
    expect(quality).toBeDefined();
    expect(quality?.overallScore).toBeGreaterThanOrEqual(0);
    expect(quality?.overallScore).toBeLessThanOrEqual(100);
    expect(typeof quality?.authenticityScore).toBe("number");
    expect(typeof quality?.jdMatchScore).toBe("number");
    expect(typeof quality?.evidenceScore).toBe("number");
    expect(typeof quality?.metricScore).toBe("number");
    expect(typeof quality?.expressionScore).toBe("number");
    expect(typeof quality?.layoutScore).toBe("number");
    expect(Array.isArray(quality?.risks)).toBe(true);
    expect(Array.isArray(quality?.suggestions)).toBe(true);
    expect(Array.isArray(quality?.unsupportedClaims)).toBe(true);
    expect(typeof quality?.hasCriticalRisks).toBe("boolean");
    // Healthy resume: no critical risks expected.
    expect(quality?.hasCriticalRisks).toBe(false);
  });

  it("flags hasCriticalRisks=true when an unsupported high-impact claim is present, but still completes the export", async () => {
    const measurer: ResumeLayoutMeasurer = {
      async measure(): Promise<ResumeLayoutMeasurement> {
        return { contentHeightPx: 850, pageUsableHeightPx: 987, measurer: "heuristic" };
      },
    };
    await bootKernel(measurer);

    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "Phase8 Hype" });
    await kernel.productServices.resumeService.addResumeItem("user-1", resume.id, {
      title: "Engineer",
      contentSnapshot: "Engineer\n- Achieved 100% perfect launch and became the industry-first solution overnight.",
      metadata: {
        itemId: "i-1",
        bulletIds: ["b-hype"],
        bulletTexts: { "b-hype": "Achieved 100% perfect launch and became the industry-first solution overnight." },
        relevanceScore: 0.9,
      },
    });

    const created = await server.inject({
      method: "POST",
      url: `/exports/resumes/${resume.id}`,
      headers: { "x-user-id": "user-1", "content-type": "application/json" },
      payload: { format: "html", templateId: "one-page-modern" },
    });
    const data = (created.json() as ApiSuccess<{ exportRecord: ResumeExport; job: BackgroundJob }>).data;
    await kernel.jobRunner.runJob(data.job.id, "user-1");

    const completed = await kernel.exportService.getExport("user-1", data.exportRecord.id);
    // Phase 8 contract: critical risks NEVER block export.
    expect(completed?.status).toBe("completed");
    expect(completed?.fileId).toEqual(expect.any(String));
    const quality = completed?.qualityReport;
    expect(quality?.hasCriticalRisks).toBe(true);
    expect(quality?.unsupportedClaims.length).toBeGreaterThan(0);
    const authRisk = quality?.risks.find((r) => r.dimension === "authenticity" && r.level === "critical");
    expect(authRisk).toBeDefined();
    expect(authRisk?.bulletId).toBe("b-hype");
  });
});
