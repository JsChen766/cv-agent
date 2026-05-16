import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/api/createServer.js";
import { createKernel } from "../src/api/kernel/createKernel.js";
import type { ApiSuccess } from "../src/api/response.js";
import type { ApiKernel } from "../src/api/types.js";
import type { CopilotChatResponse } from "../src/copilot/types.js";
import type { GeneratedArtifact, EvidenceChain } from "../src/knowledge/types.js";

describe("GET /debug/agent-modes", () => {
  let kernel: ApiKernel;
  let server: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    process.env.AUTH_MODE = "dev_header";
    process.env.AGENT_PROVIDER = "mock";
    process.env.FRONTDESK_AGENT_MODE = "mock";
    process.env.NODE_ENV = "test";
    delete process.env.DATABASE_URL;
    kernel = await createKernel();
    server = await createServer(kernel);
  });

  afterEach(async () => {
    await server.close();
    await kernel.close();
  });

  it("returns provider, llm, database, and agents sections", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/debug/agent-modes",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as ApiSuccess<Record<string, unknown>>;
    expect(body.ok).toBe(true);

    const data = body.data as Record<string, unknown>;
    expect(data.provider).toBeDefined();
    expect(data.llm).toBeDefined();
    expect(data.database).toBeDefined();
    expect(data.agents).toBeDefined();

    const provider = data.provider as Record<string, unknown>;
    expect(typeof provider.configured).toBe("string");
    expect(typeof provider.active).toBe("string");
    expect(typeof provider.isMock).toBe("boolean");

    const database = data.database as Record<string, unknown>;
    expect(typeof database.isPostgres).toBe("boolean");

    const agents = data.agents as Record<string, unknown>;
    expect(typeof agents.experienceExtractor).toBe("string");
    expect(typeof agents.artifactGenerator).toBe("string");
    expect(typeof agents.criticAgent).toBe("string");
    expect(typeof agents.revisionAgent).toBe("string");
  });
});

describe("POST /copilot/chat", () => {
  let kernel: ApiKernel;
  let server: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    process.env.AUTH_MODE = "dev_header";
    process.env.AGENT_PROVIDER = "mock";
    process.env.FRONTDESK_AGENT_MODE = "mock";
    process.env.EXPERIENCE_EXTRACTOR_MODE = "deterministic";
    process.env.ARTIFACT_GENERATOR_MODE = "deterministic";
    process.env.CRITIC_AGENT_MODE = "deterministic";
    process.env.REVISION_AGENT_MODE = "deterministic";
    process.env.NODE_ENV = "test";
    delete process.env.DATABASE_URL;
    kernel = await createKernel();
    server = await createServer(kernel);
  });

  afterEach(async () => {
    await server.close();
    await kernel.close();
  });

  it("returns clarifying_question when no resume or JD is provided", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: { message: "Hello" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as ApiSuccess<CopilotChatResponse>;
    expect(body.ok).toBe(true);
    expect(body.data.assistantMessage.kind).toBe("clarifying_question");
    expect(body.data.assistantMessage.content.length).toBeGreaterThan(10);
  });

  it("returns clarifying_question when only resume is provided (no JD)", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: {
        message: "Here is my resume",
        resumeText: "Senior engineer with 10 years of React experience.",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as ApiSuccess<CopilotChatResponse>;
    expect(body.ok).toBe(true);
    expect(body.data.assistantMessage.kind).toBe("clarifying_question");
  });

  it("returns full chat response with resume + JD + targetRole", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: {
        message: "Generate resume content for this role",
        resumeText: "As a Frontend Engineer at Acme Corp, I built React and TypeScript systems and reduced bundle size by 40%.",
        jdText: "React TypeScript performance design system role.",
        targetRole: "Frontend Engineer",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as ApiSuccess<CopilotChatResponse>;
    expect(body.ok).toBe(true);

    const data = body.data;
    // sessionId and turnId should be present
    expect(typeof data.sessionId).toBe("string");
    expect(data.sessionId.length).toBeGreaterThan(0);
    expect(typeof data.turnId).toBe("string");
    expect(data.turnId.length).toBeGreaterThan(0);

    // assistantMessage
    expect(data.assistantMessage.role).toBe("assistant");
    expect(data.assistantMessage.content.length).toBeGreaterThan(0);

    // timeline
    expect(data.timeline.length).toBeGreaterThan(0);
    expect(data.timeline[0].status).toBe("completed");

    // workspace
    expect(data.workspace.sessionId).toBe(data.sessionId);

    // raw
    expect(Array.isArray(data.raw.artifactIds)).toBe(true);
    expect(Array.isArray(data.raw.evidenceChainIds)).toBe(true);
    expect(Array.isArray(data.raw.critiqueItemIds)).toBe(true);
    expect(Array.isArray(data.raw.decisionIds)).toBe(true);
  });

  it("reuses existing session when sessionId is provided", async () => {
    // First request creates session
    const first = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: {
        message: "Generate content",
        jdText: "React role",
        targetRole: "Frontend Engineer",
      },
    });
    const firstBody = first.json() as ApiSuccess<CopilotChatResponse>;
    const sessionId = firstBody.data.sessionId;

    // Second request reuses session
    const second = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: {
        sessionId,
        message: "Make it more conservative",
        jdText: "React role",
      },
    });

    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as ApiSuccess<CopilotChatResponse>;
    expect(secondBody.data.sessionId).toBe(sessionId);
  });

  it("rejects missing message field", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/copilot/chat",
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
    process.env.AUTH_MODE = "dev_header";
    process.env.AGENT_PROVIDER = "mock";
    process.env.FRONTDESK_AGENT_MODE = "mock";
    process.env.EXPERIENCE_EXTRACTOR_MODE = "deterministic";
    process.env.ARTIFACT_GENERATOR_MODE = "deterministic";
    process.env.CRITIC_AGENT_MODE = "deterministic";
    process.env.REVISION_AGENT_MODE = "deterministic";
    process.env.NODE_ENV = "test";
    delete process.env.DATABASE_URL;
    kernel = await createKernel();
    server = await createServer(kernel);

    // Create a session with content first
    const chatResponse = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: {
        message: "Generate resume content",
        resumeText: "As a Frontend Engineer at Acme Corp, I built React systems and reduced bundle size by 40%.",
        jdText: "React TypeScript role.",
        targetRole: "Frontend Engineer",
      },
    });
    const chatBody = chatResponse.json() as ApiSuccess<CopilotChatResponse>;
    sessionId = chatBody.data.sessionId;
  });

  afterEach(async () => {
    await server.close();
    await kernel.close();
  });

  it("accepts a variant and returns decision_summary", async () => {
    const variantId = "any-variant-id";
    const response = await server.inject({
      method: "POST",
      url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: {
        sessionId,
        action: { type: "accept", variantId },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as ApiSuccess<CopilotChatResponse>;
    expect(body.data.assistantMessage.kind).toBe("decision_summary");
  });

  it("rejects a variant", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: {
        sessionId,
        action: { type: "reject", variantId: "any-variant-id" },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as ApiSuccess<CopilotChatResponse>;
    expect(body.data.timeline.some((t) => t.type === "user_decision")).toBe(true);
  });

  it("prefers a variant and updates decisionState", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: {
        sessionId,
        action: { type: "prefer", variantId: "any-variant-id" },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as ApiSuccess<CopilotChatResponse>;
    expect(body.data.assistantMessage.kind).toBe("decision_summary");
  });

  it("show_evidence returns evidence_explanation message kind", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: {
        sessionId,
        action: { type: "show_evidence", variantId: "any-variant-id" },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as ApiSuccess<CopilotChatResponse>;
    expect(body.data.assistantMessage.kind).toBe("evidence_explanation");
  });

  it("returns 404 for unknown session", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: {
        sessionId: "non-existent-session",
        action: { type: "accept", variantId: "var-1" },
      },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("POST /copilot/chat/stream", () => {
  let kernel: ApiKernel;
  let server: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    process.env.AUTH_MODE = "dev_header";
    process.env.AGENT_PROVIDER = "mock";
    process.env.FRONTDESK_AGENT_MODE = "mock";
    process.env.EXPERIENCE_EXTRACTOR_MODE = "deterministic";
    process.env.ARTIFACT_GENERATOR_MODE = "deterministic";
    process.env.CRITIC_AGENT_MODE = "deterministic";
    process.env.REVISION_AGENT_MODE = "deterministic";
    process.env.NODE_ENV = "test";
    delete process.env.DATABASE_URL;
    kernel = await createKernel();
    server = await createServer(kernel);
  });

  afterEach(async () => {
    await server.close();
    await kernel.close();
  });

  it("returns SSE with product-level events", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/copilot/chat/stream",
      headers: { "x-user-id": "user-1" },
      payload: {
        message: "Generate content",
        jdText: "React TypeScript role",
        targetRole: "Frontend Engineer",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.body;
    expect(body).toContain("event: ");
    expect(body).toContain("data: ");
    expect(body).toContain("timeline");
    expect(body).toContain("done");
  });

  it("returns clarifying events when JD is missing", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/copilot/chat/stream",
      headers: { "x-user-id": "user-1" },
      payload: {
        message: "Hello",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.body;
    expect(body).toContain("event: ");
    expect(body).toContain("done");
  });

  it("does not expose raw chain-of-thought or reasoning_content in SSE", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/copilot/chat/stream",
      headers: { "x-user-id": "user-1" },
      payload: {
        message: "Generate content",
        jdText: "React TypeScript role",
        targetRole: "Frontend Engineer",
      },
    });

    const body = response.body;
    expect(body).not.toContain("chain-of-thought");
    expect(body).not.toContain("chain_of_thought");
    expect(body).not.toContain("reasoning_content");
    expect(body).not.toContain("internal_prompt");
    expect(body).not.toContain("tool_args");
  });
});

describe("CopilotChatResponse safety", () => {
  let kernel: ApiKernel;
  let server: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    process.env.AUTH_MODE = "dev_header";
    process.env.AGENT_PROVIDER = "mock";
    process.env.FRONTDESK_AGENT_MODE = "mock";
    process.env.EXPERIENCE_EXTRACTOR_MODE = "deterministic";
    process.env.ARTIFACT_GENERATOR_MODE = "deterministic";
    process.env.CRITIC_AGENT_MODE = "deterministic";
    process.env.REVISION_AGENT_MODE = "deterministic";
    process.env.NODE_ENV = "test";
    delete process.env.DATABASE_URL;
    kernel = await createKernel();
    server = await createServer(kernel);
  });

  afterEach(async () => {
    await server.close();
    await kernel.close();
  });

  function checkNoLeaks(data: unknown, path: string): void {
    if (typeof data === "string") {
      expect(data, `String at ${path} should not contain chain-of-thought`).not.toContain("chain-of-thought");
      expect(data, `String at ${path} should not contain reasoning_content`).not.toContain("reasoning_content");
      expect(data, `String at ${path} should not contain internal prompt`).not.toContain("internal_prompt");
      expect(data, `String at ${path} should not contain tool_args`).not.toContain("tool_args");
      return;
    }
    if (Array.isArray(data)) {
      for (let i = 0; i < data.length; i++) {
        checkNoLeaks(data[i], `${path}[${i}]`);
      }
      return;
    }
    if (typeof data === "object" && data !== null) {
      for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
        checkNoLeaks(value, `${path}.${key}`);
      }
    }
  }

  it("copilot chat response contains no chain-of-thought or reasoning leaks", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: {
        message: "Generate content",
        resumeText: "Senior engineer with React experience.",
        jdText: "React role",
        targetRole: "Frontend Engineer",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as ApiSuccess<CopilotChatResponse>;

    // Serialize to JSON and check for any leaks
    const json = JSON.stringify(body);
    expect(json).not.toContain("chain-of-thought");
    expect(json).not.toContain("chain_of_thought");
    expect(json).not.toContain("reasoning_content");
    expect(json).not.toContain("internal_prompt");
    expect(json).not.toContain("internal system prompt");

    // Deep check
    checkNoLeaks(body, "response");
  });

  it("clarifying question response contains no leaks", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: { message: "Hello" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as ApiSuccess<CopilotChatResponse>;
    const json = JSON.stringify(body);
    expect(json).not.toContain("chain-of-thought");
    expect(json).not.toContain("reasoning_content");
    expect(json).not.toContain("internal_prompt");
  });
});
