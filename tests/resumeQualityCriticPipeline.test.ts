import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/api/createServer.js";
import { createKernel } from "../src/api/kernel/createKernel.js";
import { ModelClient } from "../src/agent-core/model/ModelClient.js";
import type { LLMChatRequest, LLMChatResponse, LLMProvider } from "../src/agent-core/model/types.js";
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

function stubModelClient(handler: (req: LLMChatRequest) => string): ModelClient {
  const provider: LLMProvider = {
    name: "stub",
    async chat(req: LLMChatRequest): Promise<LLMChatResponse> { return { content: handler(req) }; },
  };
  return new ModelClient({ provider, defaultModel: "stub-model" });
}

const measurer: ResumeLayoutMeasurer = {
  async measure(): Promise<ResumeLayoutMeasurement> {
    return { contentHeightPx: 850, pageUsableHeightPx: 987, measurer: "heuristic" };
  },
};

describe("Phase 8 Hybrid Resume Critic �� qualityReport.criticReview pipeline", () => {
  let kernel: ApiKernel;
  let server: Awaited<ReturnType<typeof createServer>>;
  let pdfRenderer: PdfRendererAdapter;

  async function bootKernel(opts: { modelClient?: ModelClient; enable: boolean }) {
    setupEnv();
    if (!opts.enable) delete process.env.ENABLE_LLM_QUALITY_CRITIC;
    else process.env.ENABLE_LLM_QUALITY_CRITIC = "true";
    pdfRenderer = { async render(html: string) { return new FakePdfRenderer().render(html); } };
    kernel = await createKernel({ pdfRenderer, layoutMeasurer: measurer, modelClient: opts.modelClient });
    server = await createServer(kernel);
  }

  afterEach(async () => {
    delete process.env.JOB_WORKER_ENABLED;
    delete process.env.PDF_RENDERER;
    delete process.env.FILE_STORAGE_PROVIDER;
    delete process.env.ENABLE_LLM_QUALITY_CRITIC;
    if (server) await server.close();
    if (kernel) await kernel.close();
  });

  async function seedHealthyResume(): Promise<string> {
    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "Phase8 Critic" });
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

  async function runExport(resumeId: string): Promise<ResumeExport | null> {
    const created = await server.inject({
      method: "POST",
      url: `/exports/resumes/${resumeId}`,
      headers: { "x-user-id": "user-1", "content-type": "application/json" },
      payload: { format: "html", templateId: "one-page-modern" },
    });
    expect(created.statusCode).toBe(200);
    const data = (created.json() as ApiSuccess<{ exportRecord: ResumeExport; job: BackgroundJob }>).data;
    await kernel.jobRunner.runJob(data.job.id, "user-1");
    return kernel.exportService.getExport("user-1", data.exportRecord.id);
  }

  it("does NOT invoke the critic when ENABLE_LLM_QUALITY_CRITIC is unset (Phase 8 baseline preserved)", async () => {
    await bootKernel({ enable: false });
    const resumeId = await seedHealthyResume();
    const completed = await runExport(resumeId);
    expect(completed?.status).toBe("completed");
    const quality = completed?.qualityReport;
    expect(quality).toBeDefined();
    expect(quality?.criticReview).toBeUndefined();
    expect(typeof quality?.overallScore).toBe("number");
    expect(quality?.hasCriticalRisks).toBe(false);
  });

  it("does NOT invoke the critic when no modelClient is configured (even if env is on)", async () => {
    await bootKernel({ enable: true });
    const resumeId = await seedHealthyResume();
    const completed = await runExport(resumeId);
    const quality = completed?.qualityReport;
    expect(quality).toBeDefined();
    expect(quality?.criticReview).toBeUndefined();
  });

  it("invokes the critic and persists criticReview when enabled with a stub model returning valid JSON", async () => {
    let calls = 0;
    const modelClient = stubModelClient(() => {
      calls += 1;
      return JSON.stringify({
        semanticJdMatchScore: 80,
        expressionQualityScore: 70,
        authenticityReview: { risks: [{ level: "low", message: "Looks good.", itemId: "i-1", bulletId: "b-1", evidenceMissing: false }] },
        rewriteSuggestions: [{ itemId: "i-1", bulletId: "b-2", before: null, suggestion: "Cut page load by 35%.", reason: "Tighter." }],
        missingEvidence: [],
        overallComment: "Strong baseline.",
      });
    });
    await bootKernel({ modelClient, enable: true });
    const resumeId = await seedHealthyResume();
    const completed = await runExport(resumeId);
    expect(completed?.status).toBe("completed");
    expect(completed?.fileId).toEqual(expect.any(String));
    const quality = completed?.qualityReport;
    expect(quality?.criticReview).toBeDefined();
    expect(quality?.criticReview?.applied).toBe(true);
    expect(quality?.criticReview?.fallback).toBe(false);
    expect(quality?.criticReview?.reason).toBe("ok");
    expect(quality?.criticReview?.semanticJdMatchScore).toBe(80);
    expect(quality?.criticReview?.expressionQualityScore).toBe(70);
    expect(quality?.criticReview?.authenticityRisks).toHaveLength(1);
    expect(quality?.criticReview?.rewriteSuggestions).toHaveLength(1);
    expect(quality?.hasCriticalRisks).toBe(false);
    expect(calls).toBe(1);
  });

  it("falls back to rule-only qualityReport when LLM returns invalid JSON (export still completes)", async () => {
    const modelClient = stubModelClient(() => "this is not json {{");
    await bootKernel({ modelClient, enable: true });
    const resumeId = await seedHealthyResume();
    const completed = await runExport(resumeId);
    expect(completed?.status).toBe("completed");
    const quality = completed?.qualityReport;
    expect(quality).toBeDefined();
    expect(quality?.criticReview).toBeDefined();
    expect(quality?.criticReview?.applied).toBe(false);
    expect(quality?.criticReview?.fallback).toBe(true);
    expect(quality?.criticReview?.reason).toBe("schema_invalid");
    expect(typeof quality?.overallScore).toBe("number");
    expect(quality?.hasCriticalRisks).toBe(false);
  });

  it("LLM-only critical risk on a bullet WITH evidence does NOT flip hasCriticalRisks (����ӡ֤ guard)", async () => {
    const modelClient = stubModelClient(() => JSON.stringify({
      authenticityReview: { risks: [{ level: "critical", message: "Subjectively too bold.", itemId: "i-1", bulletId: "b-1", evidenceMissing: false }] },
      rewriteSuggestions: [], missingEvidence: [],
    }));
    await bootKernel({ modelClient, enable: true });
    const resumeId = await seedHealthyResume();
    const completed = await runExport(resumeId);
    const quality = completed?.qualityReport;
    expect(quality?.criticReview?.applied).toBe(true);
    expect(quality?.criticReview?.authenticityRisks[0].level).toBe("critical");
    expect(quality?.hasCriticalRisks).toBe(false);
  });

  it("LLM critical risk on a rule-flagged unsupported bullet promotes hasCriticalRisks; export still completes", async () => {
    const modelClient = stubModelClient(() => JSON.stringify({
      authenticityReview: { risks: [{ level: "critical", message: "Unsupported superlative.", itemId: "i-1", bulletId: "b-hype", evidenceMissing: true }] },
      rewriteSuggestions: [],
      missingEvidence: [{ bulletId: "b-hype", claim: "100% perfect launch", reason: "No evidence." }],
    }));
    await bootKernel({ modelClient, enable: true });
    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "Phase8 Critic Hype" });
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
    const completed = await runExport(resume.id);
    expect(completed?.status).toBe("completed");
    const quality = completed?.qualityReport;
    // Both rule layer (unsupported claim) AND critic agree ? hasCriticalRisks=true.
    expect(quality?.hasCriticalRisks).toBe(true);
    expect(quality?.unsupportedClaims.length).toBeGreaterThan(0);
    expect(quality?.criticReview?.applied).toBe(true);
    expect(quality?.criticReview?.authenticityRisks[0].level).toBe("critical");
    expect(quality?.criticReview?.missingEvidence).toHaveLength(1);
  });

  it("does NOT create any pendingAction when critic flags critical risks", async () => {
    const modelClient = stubModelClient(() => JSON.stringify({
      authenticityReview: { risks: [{ level: "critical", message: "Bold.", itemId: "i-1", bulletId: "b-1", evidenceMissing: true }] },
      rewriteSuggestions: [], missingEvidence: [],
    }));
    await bootKernel({ modelClient, enable: true });
    const resumeId = await seedHealthyResume();
    const completed = await runExport(resumeId);
    expect(completed?.status).toBe("completed");
    const pending = await kernel.pendingActions.listAll("user-1");
    // Critic must never create a confirmation loop.
    expect(pending.length).toBe(0);
  });
});