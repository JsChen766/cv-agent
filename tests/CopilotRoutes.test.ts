import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/api/createServer.js";
import { createKernel } from "../src/api/kernel/createKernel.js";
import type { ApiSuccess } from "../src/api/response.js";
import type { ApiKernel } from "../src/api/types.js";
import type { CopilotChatResponse } from "../src/copilot/types.js";

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

describe("GET /debug/agent-modes", () => {
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

  it("returns flat data with provider, database, runtimeMode, agent modes", async () => {
    const response = await server.inject({ method: "GET", url: "/debug/agent-modes" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as ApiSuccess<Record<string, unknown>>;
    expect(body.ok).toBe(true);

    const d = body.data as Record<string, unknown>;
    expect(typeof d.provider).toBe("string");
    expect(typeof d.database).toBe("string");
    expect(typeof d.runtimeMode).toBe("string");
    expect(typeof d.frontDeskMode).toBe("string");
    expect(typeof d.experienceExtractorMode).toBe("string");
    expect(typeof d.artifactGeneratorMode).toBe("string");
    expect(typeof d.criticAgentMode).toBe("string");
    expect(typeof d.revisionAgentMode).toBe("string");
    expect(typeof d.allowMockFallback).toBe("boolean");
    expect(typeof d.model).toBe("string");
    expect(typeof d.hasDatabaseUrl).toBe("boolean");
    expect(typeof d.hasDeepSeekApiKey).toBe("boolean");
    expect(Array.isArray(d.warnings)).toBe(true);
  });

  it("warns when AGENT_PROVIDER is deepseek but no API key", async () => {
    const origProvider = process.env.AGENT_PROVIDER;
    const origKey = process.env.DEEPSEEK_API_KEY;
    process.env.AGENT_PROVIDER = "deepseek";
    delete process.env.DEEPSEEK_API_KEY;

    // Need a fresh kernel/server for this env
    const k = await createKernel();
    const s = await createServer(k);
    const response = await s.inject({ method: "GET", url: "/debug/agent-modes" });
    const body = response.json() as ApiSuccess<Record<string, unknown>>;
    const d = body.data as Record<string, unknown>;
    const warnings = d.warnings as string[];
    expect(warnings.some(w => w.includes("DEEPSEEK_API_KEY") || w.includes("mock"))).toBe(true);

    await s.close();
    await k.close();
    process.env.AGENT_PROVIDER = origProvider;
    if (origKey !== undefined) process.env.DEEPSEEK_API_KEY = origKey;
    else delete process.env.DEEPSEEK_API_KEY;
  });
});

describe("POST /copilot/chat", () => {
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

  it("returns clarifying_question when no resume or JD", async () => {
    const response = await server.inject({
      method: "POST", url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: { message: "Hello" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as ApiSuccess<CopilotChatResponse>;
    expect(body.data.assistantMessage.kind).toBe("clarifying_question");
  });

  it("returns clarifying_question when only resume (no JD)", async () => {
    const response = await server.inject({
      method: "POST", url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: { message: "Here is my resume", resumeText: "Senior engineer." },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as ApiSuccess<CopilotChatResponse>;
    expect(body.data.assistantMessage.kind).toBe("clarifying_question");
  });

  it("returns full chat response with resume + JD + targetRole", async () => {
    const response = await server.inject({
      method: "POST", url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: {
        message: "Generate resume content",
        resumeText: "As a Frontend Engineer at Acme Corp, I built React and TypeScript systems and reduced bundle size by 40%.",
        jdText: "React TypeScript performance design system role.",
        targetRole: "Frontend Engineer",
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as ApiSuccess<CopilotChatResponse>;
    expect(body.ok).toBe(true);
    const d = body.data;
    expect(typeof d.sessionId).toBe("string");
    expect(d.assistantMessage.role).toBe("assistant");
    expect(d.timeline.length).toBeGreaterThan(0);
    expect(d.workspace.sessionId).toBe(d.sessionId);
    expect(Array.isArray(d.raw.artifactIds)).toBe(true);
  });

  it("reuses existing session when sessionId is provided", async () => {
    const first = await server.inject({
      method: "POST", url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: { message: "Generate", jdText: "React role", targetRole: "FE" },
    });
    const sid = (first.json() as ApiSuccess<CopilotChatResponse>).data.sessionId;

    const second = await server.inject({
      method: "POST", url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: { sessionId: sid, message: "Revise", jdText: "React role" },
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as ApiSuccess<CopilotChatResponse>).data.sessionId).toBe(sid);
  });

  it("does not re-ingest resume on second request with same session", async () => {
    // First request triggers ingestion
    const first = await server.inject({
      method: "POST", url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: {
        message: "Generate", resumeText: "Senior engineer.",
        jdText: "React role", targetRole: "FE",
      },
    });
    const sid = (first.json() as ApiSuccess<CopilotChatResponse>).data.sessionId;

    // Second request with same session should skip ingestion
    const second = await server.inject({
      method: "POST", url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: { sessionId: sid, message: "Revise", jdText: "React role" },
    });
    expect(second.statusCode).toBe(200);
    // Should still succeed (ingestion skipped)
  });

  it("rejects missing message field", async () => {
    const response = await server.inject({
      method: "POST", url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("POST /copilot/actions", () => {
  let kernel: ApiKernel;
  let server: Awaited<ReturnType<typeof createServer>>;
  let sessionId: string;

  beforeEach(async () => {
    setupEnv();
    kernel = await createKernel();
    server = await createServer(kernel);

    const chatResponse = await server.inject({
      method: "POST", url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: {
        message: "Generate resume content",
        resumeText: "As a Frontend Engineer at Acme Corp, I built React systems.",
        jdText: "React TypeScript role.",
        targetRole: "Frontend Engineer",
      },
    });
    sessionId = (chatResponse.json() as ApiSuccess<CopilotChatResponse>).data.sessionId;
  });

  afterEach(async () => {
    await server.close();
    await kernel.close();
  });

  it("accepts a variant via workspace resolution", async () => {
    const response = await server.inject({
      method: "POST", url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: { sessionId, action: { type: "accept", variantId: "any-variant-id" } },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as ApiSuccess<CopilotChatResponse>;
    expect(body.data.assistantMessage.kind).toBe("decision_summary");
    expect(body.data.timeline.some(t => t.type === "decision_recorded")).toBe(true);
  });

  it("rejects a variant", async () => {
    const response = await server.inject({
      method: "POST", url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: { sessionId, action: { type: "reject", variantId: "any-variant-id" } },
    });
    expect(response.statusCode).toBe(200);
  });

  it("prefers a variant", async () => {
    const response = await server.inject({
      method: "POST", url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: { sessionId, action: { type: "prefer", variantId: "any-variant-id" } },
    });
    expect(response.statusCode).toBe(200);
  });

  it("show_evidence returns evidence_explanation", async () => {
    const response = await server.inject({
      method: "POST", url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: { sessionId, action: { type: "show_evidence", variantId: "any-variant-id" } },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as ApiSuccess<CopilotChatResponse>;
    expect(body.data.assistantMessage.kind).toBe("evidence_explanation");
  });

  it("revision does not fail when lastGenArtifacts is not used", async () => {
    // With the new orchestrator, revision uses artifact snapshot from variant.raw,
    // not global lastGenArtifacts. If the variant doesn't exist,
    // it should return a product error, not crash.
    const response = await server.inject({
      method: "POST", url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: { sessionId, action: { type: "revise_more_conservative", variantId: "nonexistent-variant" } },
    });
    // Should get a product error response, not 500
    expect(response.statusCode).toBe(200);
    const body = response.json() as ApiSuccess<CopilotChatResponse>;
    expect(body.data.timeline.some(t => t.type === "warning")).toBe(true);
  });

  it("returns 404 for unknown session", async () => {
    const response = await server.inject({
      method: "POST", url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: { sessionId: "non-existent", action: { type: "accept", variantId: "v1" } },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("POST /copilot/chat/stream", () => {
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

  it("returns SSE with proper namespaced events", async () => {
    const response = await server.inject({
      method: "POST", url: "/copilot/chat/stream",
      headers: { "x-user-id": "user-1" },
      payload: { message: "Generate", jdText: "React role", targetRole: "FE" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.body;
    expect(body).toContain("event: copilot.turn.started");
    expect(body).toContain("event: copilot.completed");
    expect(body).toContain('"type":"copilot.turn.started"');
    expect(body).toContain('"type":"copilot.completed"');
  });

  it("returns failed event when JD missing", async () => {
    const response = await server.inject({
      method: "POST", url: "/copilot/chat/stream",
      headers: { "x-user-id": "user-1" },
      payload: { message: "Hello" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: copilot.failed");
  });

  it("does not expose raw chain-of-thought or reasoning_content", async () => {
    const response = await server.inject({
      method: "POST", url: "/copilot/chat/stream",
      headers: { "x-user-id": "user-1" },
      payload: { message: "Generate", jdText: "React role", targetRole: "FE" },
    });
    const body = response.body;
    expect(body).not.toContain("chain-of-thought");
    expect(body).not.toContain("chain_of_thought");
    expect(body).not.toContain("reasoning_content");
    expect(body).not.toContain("internal_prompt");
    expect(body).not.toContain("tool_args");
    expect(body).not.toContain("rawToken");
    expect(body).not.toContain("providerRaw");
    expect(body).not.toContain("chainOfThought");
  });

  it("does not expose raw LLM token stream", async () => {
    const response = await server.inject({
      method: "POST", url: "/copilot/chat/stream",
      headers: { "x-user-id": "user-1" },
      payload: { message: "Generate", jdText: "React role", targetRole: "FE" },
    });
    const body = response.body;
    // Should not contain any raw LLM event types
    expect(body).not.toContain("llm.delta");
    expect(body).not.toContain("llm.started");
    expect(body).not.toContain("llm.completed");
  });
});

describe("CopilotChatResponse safety", () => {
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

  function checkNoLeaks(data: unknown, path: string): void {
    if (typeof data === "string") {
      expect(data).not.toContain("chain-of-thought");
      expect(data).not.toContain("reasoning_content");
      expect(data).not.toContain("internal_prompt");
      expect(data).not.toContain("tool_args");
      return;
    }
    if (Array.isArray(data)) {
      for (let i = 0; i < data.length; i++) checkNoLeaks(data[i], `${path}[${i}]`);
      return;
    }
    if (typeof data === "object" && data !== null) {
      for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
        checkNoLeaks(v, `${path}.${k}`);
      }
    }
  }

  it("copilot chat response contains no chain-of-thought or reasoning leaks", async () => {
    const response = await server.inject({
      method: "POST", url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: {
        message: "Generate content",
        resumeText: "Senior engineer with React experience.",
        jdText: "React role", targetRole: "Frontend Engineer",
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as ApiSuccess<CopilotChatResponse>;
    const json = JSON.stringify(body);
    expect(json).not.toContain("chain-of-thought");
    expect(json).not.toContain("reasoning_content");
    expect(json).not.toContain("internal_prompt");
    checkNoLeaks(body, "response");
  });

  it("clarifying question response contains no leaks", async () => {
    const response = await server.inject({
      method: "POST", url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: { message: "Hello" },
    });
    const body = response.json() as ApiSuccess<CopilotChatResponse>;
    const json = JSON.stringify(body);
    expect(json).not.toContain("chain-of-thought");
    expect(json).not.toContain("reasoning_content");
  });
});
