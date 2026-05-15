import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/api/createServer.js";
import { createKernel } from "../src/api/kernel/createKernel.js";
import type { ApiKernel } from "../src/api/types.js";

describe("API server", () => {
  let originalDatabaseUrl: string | undefined;
  let kernel: ApiKernel;
  let server: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    originalDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    kernel = await createKernel();
    server = await createServer(kernel);
  });

  afterEach(async () => {
    await server.close();
    await kernel.close();
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it("returns health", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      mode: "in_memory",
    });
  });

  it("ingests a document from JSON text with x-user-id", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/documents/ingest",
      headers: {
        "x-user-id": "user-1",
      },
      payload: {
        fileName: "resume.md",
        mimeType: "text/markdown",
        text: [
          "# Resume",
          "As a Senior Frontend Engineer at Acme Corp, I led a React design system.",
        ].join("\n"),
      },
    });

    const body = response.json() as {
      extractedDocuments: unknown[];
      experiences: unknown[];
      evidences: unknown[];
      skills: unknown[];
      warnings: string[];
    };

    expect(response.statusCode).toBe(200);
    expect(body.extractedDocuments).toHaveLength(1);
    expect(body.experiences).toHaveLength(1);
    expect(body.evidences.length).toBeGreaterThan(0);
    expect(body.skills.length).toBeGreaterThan(0);
    expect(body.warnings).toEqual([]);
  });

  it("rejects document ingestion without x-user-id", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/documents/ingest",
      payload: {
        fileName: "resume.txt",
        text: "Built TypeScript APIs.",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "MISSING_USER_ID",
        message: "x-user-id header is required.",
      },
    });
  });

  it("generates resume artifacts with x-user-id", async () => {
    await server.inject({
      method: "POST",
      url: "/documents/ingest",
      headers: {
        "x-user-id": "user-1",
      },
      payload: {
        fileName: "resume.txt",
        mimeType: "text/plain",
        text: "As a Frontend Engineer at Acme Corp, I built React and TypeScript systems and reduced bundle size by 40%.",
      },
    });

    const response = await server.inject({
      method: "POST",
      url: "/generations",
      headers: {
        "x-user-id": "user-1",
      },
      payload: {
        jdText: "React TypeScript performance design system role.",
        targetRole: "Frontend Engineer",
      },
    });

    const body = response.json() as {
      artifacts: unknown[];
      evidenceChains: unknown[];
      graphViews: unknown[];
      persistedGeneration?: { sessionId: string };
    };

    expect(response.statusCode).toBe(200);
    expect(body.artifacts.length).toBeGreaterThan(0);
    expect(body.evidenceChains.length).toBe(body.artifacts.length);
    expect(body.graphViews.length).toBe(body.artifacts.length);
    expect(body.persistedGeneration?.sessionId).toBeTruthy();
  });

  it("uses the configured generation persistence port", async () => {
    const originalPersistence = kernel.generationPersistenceService;
    expect(originalPersistence).toBeDefined();
    let persistCalled = false;
    kernel.generationPersistenceService = {
      persist: async (result, metadata) => {
        persistCalled = true;
        return originalPersistence!.persist(result, metadata);
      },
    };

    const response = await server.inject({
      method: "POST",
      url: "/generations",
      headers: {
        "x-user-id": "user-1",
      },
      payload: {
        jdText: "React TypeScript role.",
        targetRole: "Frontend Engineer",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(persistCalled).toBe(true);
  });

  it("returns empty evidence chain snapshots for a missing session", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/generations/missing-session/evidence-chains",
      headers: {
        "x-user-id": "user-1",
      },
    });

    const body = response.json() as { evidenceChains: unknown[]; summary: string };

    expect(response.statusCode).toBe(200);
    expect(body.evidenceChains).toEqual([]);
    expect(body.summary).toContain("Found 0 evidence chains");
  });
});
