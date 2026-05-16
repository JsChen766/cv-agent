import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/api/createServer.js";
import { createKernel } from "../src/api/kernel/createKernel.js";
import type { ApiSuccess } from "../src/api/response.js";
import type { ApiKernel } from "../src/api/types.js";
import type {
  CreateGenerationResult,
  IngestDocumentResult,
} from "../src/kernel/index.js";
import type { ArtifactRevisionResult } from "../src/application/revision/index.js";
import type { GeneratedArtifact } from "../src/knowledge/types.js";
import type {
  EvidenceChainQueryResult,
} from "../src/application/query/index.js";

describe("API server", () => {
  let originalDatabaseUrl: string | undefined;
  let originalAuthMode: string | undefined;
  let originalAgentProvider: string | undefined;
  let originalFrontDeskAgentMode: string | undefined;
  let originalNodeEnv: string | undefined;
  let kernel: ApiKernel;
  let server: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    originalDatabaseUrl = process.env.DATABASE_URL;
    originalAuthMode = process.env.AUTH_MODE;
    originalAgentProvider = process.env.AGENT_PROVIDER;
    originalFrontDeskAgentMode = process.env.FRONTDESK_AGENT_MODE;
    originalNodeEnv = process.env.NODE_ENV;
    delete process.env.DATABASE_URL;
    process.env.AUTH_MODE = "dev_header";
    process.env.AGENT_PROVIDER = "mock";
    process.env.FRONTDESK_AGENT_MODE = "mock";
    process.env.NODE_ENV = "test";
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
    if (originalAuthMode === undefined) {
      delete process.env.AUTH_MODE;
    } else {
      process.env.AUTH_MODE = originalAuthMode;
    }
    if (originalAgentProvider === undefined) {
      delete process.env.AGENT_PROVIDER;
    } else {
      process.env.AGENT_PROVIDER = originalAgentProvider;
    }
    if (originalFrontDeskAgentMode === undefined) {
      delete process.env.FRONTDESK_AGENT_MODE;
    } else {
      process.env.FRONTDESK_AGENT_MODE = originalFrontDeskAgentMode;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("returns health", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as ApiSuccess<{ ok: true; mode: "postgres" | "in_memory" }>;
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({
      ok: true,
      mode: "in_memory",
      warnings: ["DATABASE_URL is not set. API is running in in-memory mode."],
    });
    expect(body.meta.mode).toBe("in_memory");
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

    const body = response.json() as ApiSuccess<IngestDocumentResult>;

    expect(response.statusCode).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.extractedDocuments).toHaveLength(1);
    expect(body.data.experiences).toHaveLength(1);
    expect(body.data.evidences.length).toBeGreaterThan(0);
    expect(body.data.skills.length).toBeGreaterThan(0);
    expect(body.data.warnings).toEqual([]);
    expect(body.meta.mode).toBe("in_memory");
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

    expect(response.statusCode).toBe(401);
    const body = response.json() as {
      ok: false;
      error: {
        code: string;
        message: string;
      };
      meta: { mode: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error).toEqual({
      code: "MISSING_AUTH",
      message: "x-user-id header is required in dev auth mode.",
    });
    expect(body.meta.mode).toBe("in_memory");
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

    const body = response.json() as ApiSuccess<CreateGenerationResult>;

    expect(response.statusCode).toBe(200);
    expect(body.data.artifacts.length).toBeGreaterThan(0);
    expect(body.data.evidenceChains.length).toBe(body.data.artifacts.length);
    expect(body.data.graphViews.length).toBe(body.data.artifacts.length);
    expect(body.data.persistedGeneration?.sessionId).toBeTruthy();
  });

  it("creates generations through the cvAgentKernel facade", async () => {
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
    const body = response.json() as ApiSuccess<CreateGenerationResult>;
    expect(body.data.persistedGeneration?.sessionId).toBeTruthy();
  });

  it("returns empty evidence chain snapshots for a missing session", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/generations/missing-session/evidence-chains",
      headers: {
        "x-user-id": "user-1",
      },
    });

    const body = response.json() as ApiSuccess<EvidenceChainQueryResult>;

    expect(response.statusCode).toBe(200);
    expect(body.data.evidenceChains).toEqual([]);
    expect(body.data.summary).toContain("Found 0 evidence chains");
  });

  it("rejects artifact revision without x-user-id", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/generations/artifacts/revise",
      payload: {
        artifact: makeRevisionArtifact("user-1"),
        instruction: "make_more_conservative",
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects artifact revision for another user", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/generations/artifacts/revise",
      headers: {
        "x-user-id": "user-1",
      },
      payload: {
        artifact: makeRevisionArtifact("user-2"),
        instruction: "make_more_conservative",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      ok: false,
      error: {
        code: "FORBIDDEN",
      },
    });
  });

  it("revises an artifact through the kernel facade route", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/generations/artifacts/revise",
      headers: {
        "x-user-id": "user-1",
      },
      payload: {
        artifact: makeRevisionArtifact("user-1"),
        instruction: "make_more_conservative",
      },
    });

    const body = response.json() as ApiSuccess<ArtifactRevisionResult>;

    expect(response.statusCode).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.revisedArtifact.metadata?.revision).toMatchObject({
      revisedFromArtifactId: "artifact-api-revision",
      deterministic: true,
    });
  });
});

describe("dev CORS", () => {
    let devKernel: ApiKernel;
    let devServer: Awaited<ReturnType<typeof createServer>>;

    beforeEach(async () => {
      process.env.AUTH_MODE = "dev_header";
      process.env.AGENT_PROVIDER = "mock";
      process.env.FRONTDESK_AGENT_MODE = "mock";
      process.env.NODE_ENV = "test";
      delete process.env.DATABASE_URL;
      devKernel = await createKernel();
      devServer = await createServer(devKernel);
    });

    afterEach(async () => {
      await devServer.close();
      await devKernel.close();
    });

    it("returns CORS headers on OPTIONS preflight in non-production", async () => {
      const response = await devServer.inject({
        method: "OPTIONS",
        url: "/health",
        headers: {
          origin: "http://127.0.0.1:5173",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type,x-user-id",
        },
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5173");
      expect(response.headers["access-control-allow-methods"]).toContain("GET");
      expect(response.headers["access-control-allow-methods"]).toContain("POST");
      expect(response.headers["access-control-allow-headers"]).toContain("content-type");
      expect(response.headers["access-control-allow-headers"]).toContain("x-user-id");
    });

    it("returns CORS headers on GET request in non-production", async () => {
      const response = await devServer.inject({
        method: "GET",
        url: "/health",
        headers: {
          origin: "http://localhost:5173",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    });

    it("returns CORS headers when origin is null (file:// use case)", async () => {
      const response = await devServer.inject({
        method: "GET",
        url: "/health",
        headers: {
          origin: "null",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBe("null");
    });

    it("allows x-user-id in requests with CORS", async () => {
      const response = await devServer.inject({
        method: "GET",
        url: "/health",
        headers: {
          origin: "http://127.0.0.1:5173",
          "x-user-id": "demo-user",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5173");
    });
  });

  describe("production CORS", () => {
    it("does not enable CORS in production without ENABLE_DEV_CORS", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalEnableDevCors = process.env.ENABLE_DEV_CORS;
      process.env.AUTH_MODE = "dev_header";
      process.env.AGENT_PROVIDER = "mock";
      process.env.FRONTDESK_AGENT_MODE = "mock";
      process.env.NODE_ENV = "production";
      delete process.env.DATABASE_URL;
      delete process.env.ENABLE_DEV_CORS;

      const prodKernel = await createKernel();
      const prodServer = await createServer(prodKernel);

      const response = await prodServer.inject({
        method: "OPTIONS",
        url: "/health",
        headers: {
          origin: "http://127.0.0.1:5173",
          "access-control-request-method": "GET",
        },
      });

      // In production without ENABLE_DEV_CORS, CORS should not be active
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();

      await prodServer.close();
      await prodKernel.close();
      process.env.NODE_ENV = originalNodeEnv;
      if (originalEnableDevCors !== undefined) {
        process.env.ENABLE_DEV_CORS = originalEnableDevCors;
      }
    });

    it("enables CORS in production when ENABLE_DEV_CORS=true", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalEnableDevCors = process.env.ENABLE_DEV_CORS;
      process.env.AUTH_MODE = "dev_header";
      process.env.AGENT_PROVIDER = "mock";
      process.env.FRONTDESK_AGENT_MODE = "mock";
      process.env.NODE_ENV = "production";
      process.env.ENABLE_DEV_CORS = "true";
      delete process.env.DATABASE_URL;

      const prodKernel = await createKernel();
      const prodServer = await createServer(prodKernel);

      const response = await prodServer.inject({
        method: "OPTIONS",
        url: "/health",
        headers: {
          origin: "http://127.0.0.1:5173",
          "access-control-request-method": "GET",
        },
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5173");

      await prodServer.close();
      await prodKernel.close();
      process.env.NODE_ENV = originalNodeEnv;
      if (originalEnableDevCors !== undefined) {
        process.env.ENABLE_DEV_CORS = originalEnableDevCors;
      }
    });
  });

function makeRevisionArtifact(userId: string): GeneratedArtifact {
  return {
    id: "artifact-api-revision",
    userId,
    type: "resume_bullet",
    content: "Improved reporting accuracy by 35%.",
    sourceExperienceIds: [],
    sourceEvidenceIds: [],
    matchedSkillIds: [],
    targetJDId: "jd-1",
    targetRequirementIds: ["req-1"],
    targetRole: "BI Analyst",
    scores: {
      overall: 0.4,
      requirementMatch: 0.4,
      evidenceStrength: 0.2,
    },
    status: "needs_review",
    metadata: {},
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}
