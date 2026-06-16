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

describe("Dual-RAG preview routes", () => {
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

  it("returns finalized Guideline and Evidence packs without generating a resume", async () => {
    await server.inject({
      method: "POST",
      url: "/product/experiences",
      headers: { "x-user-id": "user-1" },
      payload: {
        title: "LLM Retrieval Project",
        category: "project",
        content: "Implemented a Python retrieval-augmented generation pipeline and evaluated an LLM on a benchmark dataset.",
        tags: ["Python", "RAG", "LLM"],
      },
    });

    const response = await server.inject({
      method: "POST",
      url: "/product/rag/preview",
      headers: { "x-user-id": "user-1" },
      payload: {
        targetRole: "AI Algorithm Engineer Intern",
        jdText: "Develop LLM and RAG algorithms with Python and PyTorch. Research experience is preferred.",
      },
    });
    expect(response.statusCode).toBe(200);
    const data = (response.json() as ApiSuccess<{
      instructionPack: { version: string };
      evidencePack: { version: string; allowedClaims: unknown[] };
      groundingContext: { version: string };
      summary: { allowedClaimCount: number };
    }>).data;
    expect(data.instructionPack.version).toBe("guideline-rag-v2");
    expect(data.evidencePack.version).toBe("evidence-rag-v5");
    expect(data.groundingContext.version).toBe("dual-rag-v1");
    expect(data.summary.allowedClaimCount).toBeGreaterThan(0);
  });

  it("reindexes legacy experiences for persistent claim retrieval", async () => {
    await server.inject({
      method: "POST",
      url: "/product/experiences",
      headers: { "x-user-id": "user-1" },
      payload: { title: "Legacy Project", content: "Built a Python data pipeline." },
    });
    const response = await server.inject({
      method: "POST",
      url: "/product/rag/evidence/reindex",
      headers: { "x-user-id": "user-1" },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const data = (response.json() as ApiSuccess<{ scannedExperiences: number; activeClaims: number }>).data;
    expect(data.scannedExperiences).toBeGreaterThan(0);
    expect(data.activeClaims).toBeGreaterThan(0);
  });
});
