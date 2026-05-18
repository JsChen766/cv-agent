import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/api/createServer.js";
import { createKernel } from "../src/api/kernel/createKernel.js";
import { createAuthResolver } from "../src/api/auth/index.js";
import { ModelClient } from "../src/core/model/ModelClient.js";
import type { LLMProvider } from "../src/core/model/LLMProvider.js";
import type { LLMChatRequest, LLMChatResponse, LLMStreamChunk } from "../src/core/model/types.js";
import type { ApiSuccess } from "../src/api/response.js";
import type { ApiKernel } from "../src/api/types.js";

const ORIGINAL_ENV = { ...process.env };

describe("backend hardening", () => {
  let kernel: ApiKernel;
  let server: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: "test",
      AUTH_MODE: "dev_header",
      AGENT_PROVIDER: "mock",
      FRONTDESK_AGENT_MODE: "fake",
      EXPERIENCE_EXTRACTOR_MODE: "deterministic",
      ARTIFACT_GENERATOR_MODE: "deterministic",
      CRITIC_AGENT_MODE: "deterministic",
      REVISION_AGENT_MODE: "deterministic",
    };
    delete process.env.DATABASE_URL;
    delete process.env.RATE_LIMIT_ENABLED;
    delete process.env.FINAL_ANSWER_SYNTHESIS;
    kernel = await createKernel();
    server = await createServer(kernel);
  });

  afterEach(async () => {
    await server.close();
    await kernel.close();
    process.env = { ...ORIGINAL_ENV };
  });

  it("replays same idempotency key/body and rejects same key with a different body", async () => {
    const first = await server.inject({
      method: "POST",
      url: "/product/experiences",
      headers: { "x-user-id": "idem-user", "idempotency-key": "exp-key-1" },
      payload: { title: "A", content: "Built React systems and reduced bundle size by 40%." },
    });
    const replay = await server.inject({
      method: "POST",
      url: "/product/experiences",
      headers: { "x-user-id": "idem-user", "idempotency-key": "exp-key-1" },
      payload: { title: "A", content: "Built React systems and reduced bundle size by 40%." },
    });
    const conflict = await server.inject({
      method: "POST",
      url: "/product/experiences",
      headers: { "x-user-id": "idem-user", "idempotency-key": "exp-key-1" },
      payload: { title: "B", content: "Built Node systems and reduced latency by 20%." },
    });

    expect(first.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("isolates idempotency keys by user", async () => {
    const payload = { title: "A", content: "Built React systems and reduced bundle size by 40%." };
    const a = await server.inject({ method: "POST", url: "/product/experiences", headers: { "x-user-id": "user-a", "idempotency-key": "shared-key" }, payload });
    const b = await server.inject({ method: "POST", url: "/product/experiences", headers: { "x-user-id": "user-b", "idempotency-key": "shared-key" }, payload });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect((a.json() as ApiSuccess<any>).data.experience.userId).toBe("user-a");
    expect((b.json() as ApiSuccess<any>).data.experience.userId).toBe("user-b");
  });

  it("applies request rate limits when enabled", async () => {
    process.env.RATE_LIMIT_ENABLED = "true";
    process.env.RATE_LIMIT_PER_USER_PER_MINUTE = "1";
    const one = await server.inject({ method: "GET", url: "/product/experiences", headers: { "x-user-id": "rate-user" } });
    const two = await server.inject({ method: "GET", url: "/product/experiences", headers: { "x-user-id": "rate-user" } });
    expect(one.statusCode).toBe(200);
    expect(two.statusCode).toBe(429);
    expect(two.json().error.code).toBe("RATE_LIMITED");
  });

  it("returns SESSION_LOCKED for an already locked session and allows expired locks", async () => {
    const acquired = await kernel.platformServices.sessionLocks.acquire({ userId: "lock-user", sessionId: "s1", ownerRequestId: "req-1", ttlMs: 1000 });
    const blocked = await kernel.platformServices.sessionLocks.acquire({ userId: "lock-user", sessionId: "s1", ownerRequestId: "req-2", ttlMs: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const expired = await kernel.platformServices.sessionLocks.acquire({ userId: "lock-user", sessionId: "s2", ownerRequestId: "req-1", ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const reacquired = await kernel.platformServices.sessionLocks.acquire({ userId: "lock-user", sessionId: "s2", ownerRequestId: "req-2", ttlMs: 1000 });
    expect(acquired).toBe(true);
    expect(blocked).toBe(false);
    expect(expired).toBe(true);
    expect(reacquired).toBe(true);
  });

  it("creates agent run and tool run logs without sensitive fields", async () => {
    process.env.DEBUG_ROUTES_ENABLED = "true";
    const chat = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "log-user" },
      payload: { message: "Show my experience library.", userId: "evil-user" },
    });
    expect(chat.statusCode).toBe(200);

    const runs = await server.inject({ method: "GET", url: "/debug/agent-runs", headers: { "x-user-id": "log-user" } });
    const run = (runs.json() as ApiSuccess<any[]>).data[0];
    const detail = await server.inject({ method: "GET", url: `/debug/agent-runs/${run.id}`, headers: { "x-user-id": "log-user" } });
    const text = detail.body;
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as ApiSuccess<any>).data.tools.length).toBeGreaterThan(0);
    expect(text).not.toContain("providerRaw");
    expect(text).not.toContain("internal_prompt");
    expect(text).not.toContain("evil-user");
  });

  it("supports background job create/list/get/cancel with user isolation", async () => {
    const created = await server.inject({
      method: "POST",
      url: "/jobs",
      headers: { "x-user-id": "job-user" },
      payload: { type: "export_pdf", input: { resumeId: "resume-1" } },
    });
    const job = (created.json() as ApiSuccess<any>).data;
    const list = await server.inject({ method: "GET", url: "/jobs", headers: { "x-user-id": "job-user" } });
    const hidden = await server.inject({ method: "GET", url: `/jobs/${job.id}`, headers: { "x-user-id": "other-user" } });
    const cancelled = await server.inject({ method: "POST", url: `/jobs/${job.id}/cancel`, headers: { "x-user-id": "job-user" } });
    expect(created.statusCode).toBe(200);
    expect((list.json() as ApiSuccess<any[]>).data).toHaveLength(1);
    expect(hidden.statusCode).toBe(404);
    expect((cancelled.json() as ApiSuccess<any>).data.status).toBe("cancelled");
  });

  it("rejects disabled auth outside test unless explicitly allowed", () => {
    process.env.NODE_ENV = "development";
    process.env.AUTH_MODE = "disabled";
    delete process.env.ALLOW_INSECURE_AUTH;
    expect(() => createAuthResolver()).toThrow("AUTH_MODE=disabled is only allowed");
  });

  it("rejects very long copilot input before model execution", async () => {
    process.env.LLM_MAX_PROMPT_CHARS = "5";
    const response = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "quota-user" },
      payload: { message: "this message is too long" },
    });
    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe("QUOTA_EXCEEDED");
  });

  it("uses final answer synthesis when configured and falls back otherwise", async () => {
    await server.close();
    await kernel.close();
    process.env.FINAL_ANSWER_SYNTHESIS = "llm";
    kernel = await createKernel();
    kernel.frontDeskModelClient = new ModelClient({ provider: new SynthesisProvider(), defaultModel: "synthesis-test" });
    server = await createServer(kernel);
    const response = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "synthesis-user" },
      payload: { message: "Show my experience library." },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as ApiSuccess<any>).data.assistantMessage.content).toBe("Here is the synthesized answer.");
    expect(response.body).not.toContain("tool_args");
    expect(response.body).not.toContain("providerRaw");
  });
});

class SynthesisProvider implements LLMProvider {
  public readonly name = "synthesis-test";
  private calls = 0;

  public async chat(_request: LLMChatRequest): Promise<LLMChatResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: JSON.stringify({
          mode: "call_tool",
          assistantMessage: "I will open it.",
          toolCalls: [{ toolName: "list_experiences", arguments: {} }],
          confidence: 0.9,
        }),
      };
    }
    return { content: "Here is the synthesized answer." };
  }

  public async *stream(_request: LLMChatRequest): AsyncIterable<LLMStreamChunk> {
    yield { contentDelta: "" };
  }
}
