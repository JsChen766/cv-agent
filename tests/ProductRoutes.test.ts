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

  it("creates import jobs, candidates, and accepts a candidate", async () => {
    const importResponse = await server.inject({
      method: "POST",
      url: "/product/imports/text",
      headers: { "x-user-id": "user-1" },
      payload: { rawText: "Built React systems.\n\nReduced bundle size." },
    });
    const data = (importResponse.json() as ApiSuccess<{ candidates: Array<{ id: string }> }>).data;
    expect(data.candidates.length).toBeGreaterThan(0);
    const accept = await server.inject({
      method: "POST",
      url: `/product/import-candidates/${data.candidates[0]!.id}/accept`,
      headers: { "x-user-id": "user-1" },
    });
    expect(accept.statusCode).toBe(200);
  });

  it("generates variants from JD and creates a product generation", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/product/generations/from-jd",
      headers: { "x-user-id": "user-1" },
      payload: { jdText: "React TypeScript performance optimization role.", targetRole: "Frontend Engineer" },
    });
    const data = (response.json() as ApiSuccess<{ generationId: string; variants: unknown[] }>).data;
    expect(response.statusCode).toBe(200);
    expect(data.generationId).toMatch(/^pgen-/);
    expect(data.variants.length).toBeGreaterThan(0);
  });
});
