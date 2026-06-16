import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

/** Stub provider that returns a JSON action payload from a per-test handler. */
function stubModelClient(handler: (req: LLMChatRequest) => string): ModelClient {
  const provider: LLMProvider = {
    name: "stub",
    async chat(req: LLMChatRequest): Promise<LLMChatResponse> {
      return { content: handler(req) };
    },
  };
  return new ModelClient({ provider, defaultModel: "stub-model" });
}

describe("Phase 7 fit-engine v3 — LLM-driven fit editor pipeline", () => {
  let kernel: ApiKernel;
  let server: Awaited<ReturnType<typeof createServer>>;
  let pdfRenderer: PdfRendererAdapter;

  async function bootKernel(opts: {
    measurer: ResumeLayoutMeasurer;
    modelClient?: ModelClient;
    enable?: boolean;
  }) {
    setupEnv();
    if (opts.enable === false) delete process.env.ENABLE_LLM_FIT_EDITOR;
    else process.env.ENABLE_LLM_FIT_EDITOR = "true";
    pdfRenderer = { async render(html: string) { return new FakePdfRenderer().render(html); } };
    kernel = await createKernel({
      pdfRenderer,
      layoutMeasurer: opts.measurer,
      modelClient: opts.modelClient,
    });
    server = await createServer(kernel);
  }

  afterEach(async () => {
    delete process.env.JOB_WORKER_ENABLED;
    delete process.env.PDF_RENDERER;
    delete process.env.FILE_STORAGE_PROVIDER;
    delete process.env.ENABLE_LLM_FIT_EDITOR;
    if (server) await server.close();
    if (kernel) await kernel.close();
  });

  it("invokes the LLM fit editor and persists editReport when Phase 6 leaves the resume still overflowing", async () => {
    // Simulated measurer: page always overflows so Phase 6 can never resolve overflow,
    // which causes Phase 7 to trigger with "still_overflowing".
    const measurer: ResumeLayoutMeasurer = {
      async measure(): Promise<ResumeLayoutMeasurement> {
        return { contentHeightPx: 1500, pageUsableHeightPx: 987, measurer: "heuristic" };
      },
    };
    // Stub LLM returns a syntactically valid empty action set (no edits) — Phase 7 will
    // record applied=false and reason="no_actions" but still surface the trigger.
    const modelClient = stubModelClient(() =>
      JSON.stringify({ actions: [], reason: "no_safe_edit", notes: "nothing safe" }),
    );
    await bootKernel({ measurer, modelClient });

    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "Phase7 still overflow" });
    await kernel.productServices.resumeService.addResumeItem("user-1", resume.id, {
      title: "Senior Engineer",
      contentSnapshot: "Senior \u00B7 Acme \u00B7 2022 \u2013 2024\n- One bullet that is long enough.",
      metadata: {
        itemId: "i-1",
        bulletIds: ["b-1"],
        bulletRelevance: { "b-1": 0.5 },
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
    expect(completed?.compressionReport?.stillOverflowing).toBe(true);

    const edit = completed?.editReport;
    expect(edit).toBeDefined();
    expect(edit?.trigger).toBe("still_overflowing");
    // No actions emitted by stub → applied=false, fallback=true, reason="all_rejected".
    expect(edit?.applied).toBe(false);
    expect(edit?.fallback).toBe(true);
    expect(edit?.reason).toBe("all_rejected");
  });

  it("does NOT invoke the LLM fit editor when ENABLE_LLM_FIT_EDITOR is unset", async () => {
    const measurer: ResumeLayoutMeasurer = {
      async measure(): Promise<ResumeLayoutMeasurement> {
        return { contentHeightPx: 1500, pageUsableHeightPx: 987, measurer: "heuristic" };
      },
    };
    const modelClient = stubModelClient(() => {
      throw new Error("LLM should not be called when feature flag is off");
    });
    await bootKernel({ measurer, modelClient, enable: false });

    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "Phase7 disabled" });
    await kernel.productServices.resumeService.addResumeItem("user-1", resume.id, {
      title: "Engineer",
      contentSnapshot: "Engineer\n- bullet",
      metadata: { itemId: "i-1", bulletIds: ["b-1"] },
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
    // Phase 6 still ran (template + targetPages match), but Phase 7 must be bypassed.
    expect(completed?.editReport).toBeUndefined();
  });
});
