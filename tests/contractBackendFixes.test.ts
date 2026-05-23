import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/api/createServer.js";
import { createKernel } from "../src/api/kernel/createKernel.js";
import type { ApiSuccess } from "../src/api/response.js";
import type { ApiKernel } from "../src/api/types.js";
import { AgentOrchestrator } from "../src/agent-core/runtime/AgentOrchestrator.js";
import { CopilotOrchestrator } from "../src/copilot/CopilotOrchestrator.js";
import { createP12Kernel } from "./p12Helpers.js";
import { createTestKernelContext } from "../src/api/context.js";
import { ModelClient } from "../src/agent-core/model/ModelClient.js";
import type { LLMChatRequest, LLMChatResponse, LLMProvider } from "../src/agent-core/model/types.js";

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

describe("Contract: imports/text rawText and text compatibility", () => {
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

  it("accepts { rawText }", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/product/imports/text",
      headers: { "x-user-id": "user-1" },
      payload: { rawText: "Built React systems." },
    });
    expect(response.statusCode).toBe(200);
    const data = (response.json() as ApiSuccess<{ candidates: unknown[] }>).data;
    expect(data.candidates.length).toBeGreaterThan(0);
  });

  it("accepts { text }", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/product/imports/text",
      headers: { "x-user-id": "user-1" },
      payload: { text: "Reduced bundle size." },
    });
    expect(response.statusCode).toBe(200);
    const data = (response.json() as ApiSuccess<{ candidates: unknown[] }>).data;
    expect(data.candidates.length).toBeGreaterThan(0);
  });

  it("prioritizes rawText over text", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/product/imports/text",
      headers: { "x-user-id": "user-1" },
      payload: { rawText: "Raw text content.", text: "Fallback text." },
    });
    expect(response.statusCode).toBe(200);
    const data = (response.json() as ApiSuccess<{ candidates: unknown[] }>).data;
    expect(data.candidates.length).toBeGreaterThan(0);
  });
});

describe("Contract: experience revisions", () => {
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

  it("creates a revision and updates currentRevisionId", async () => {
    // Create experience
    const created = await server.inject({
      method: "POST",
      url: "/product/experiences",
      headers: { "x-user-id": "user-1" },
      payload: { title: "Test experience", content: "Original content." },
    });
    const exp = (created.json() as ApiSuccess<{ experience: { id: string; currentRevisionId: string } }>).data;

    // Create revision
    const rev = await server.inject({
      method: "POST",
      url: `/product/experiences/${exp.experience.id}/revisions`,
      headers: { "x-user-id": "user-1" },
      payload: { content: "Updated content.", source: "copilot" },
    });
    expect(rev.statusCode).toBe(200);

    // Fetch detail — should include new revision and updated currentRevisionId
    const detail = await server.inject({
      method: "GET",
      url: `/product/experiences/${exp.experience.id}`,
      headers: { "x-user-id": "user-1" },
    });
    const detailData = (detail.json() as ApiSuccess<{ experience: { currentRevisionId: string }; revisions: unknown[]; variants: unknown[] }>).data;
    expect(detailData.revisions.length).toBeGreaterThanOrEqual(2);
    expect(detailData.experience.currentRevisionId).not.toBe(exp.experience.currentRevisionId);
    // variants should be present (even if empty)
    expect(Array.isArray(detailData.variants)).toBe(true);
  });
});

describe("Contract: copilot explicit actions", () => {
  it("rewrite_experience without experienceId returns needs_input", async () => {
    const kernel = await createP12Kernel();
    const runtime = new AgentOrchestrator({ kernel });
    const ctx = createTestKernelContext({ user: { id: "user-1" }, request: { requestId: "req-1", traceId: "trace-1" } });
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});

    const result = await runtime.handleExplicitAction(ctx, {
      sessionId: session.id,
      action: { type: "rewrite_experience" },
    });
    expect(result.raw.actionResults?.[0]).toMatchObject({
      status: "needs_input",
      missingInputs: ["experienceId"],
    });
    await kernel.close();
  });

  it("rewrite_experience with activeExperienceId creates pending action", async () => {
    const kernel = await createP12Kernel();
    const runtime = new AgentOrchestrator({ kernel });
    const ctx = createTestKernelContext({ user: { id: "user-1" }, request: { requestId: "req-1", traceId: "trace-1" } });
    const { experience } = await kernel.productServices.experienceService.createExperience("user-1", {
      title: "Test", content: "Test content.",
    });
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});

    const result = await runtime.handleExplicitAction(ctx, {
      sessionId: session.id,
      action: { type: "rewrite_experience", payload: { experienceId: experience.id, content: "Rewritten content." } },
    });
    // Should create a pending action for the update_experience tool
    expect(result.raw.pendingActions?.[0]).toMatchObject({ toolName: "update_experience" });
    expect(result.raw.actionResults?.[0]?.status).toBe("needs_confirmation");
    expect(result.raw.actionResults?.[0]?.pendingActionId).toBeTruthy();
    await kernel.close();
  });

  it("optimize_resume_item without resumeItemId returns needs_input", async () => {
    const kernel = await createP12Kernel();
    const runtime = new AgentOrchestrator({ kernel });
    const ctx = createTestKernelContext({ user: { id: "user-1" }, request: { requestId: "req-1", traceId: "trace-1" } });
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});

    const result = await runtime.handleExplicitAction(ctx, {
      sessionId: session.id,
      action: { type: "optimize_resume_item" },
    });
    expect(result.raw.actionResults?.[0]).toMatchObject({
      status: "needs_input",
      missingInputs: ["resumeItemId"],
    });
    await kernel.close();
  });

  it("generate_from_jd without jdId/jdText returns needs_input", async () => {
    const kernel = await createP12Kernel();
    const runtime = new AgentOrchestrator({ kernel });
    const ctx = createTestKernelContext({ user: { id: "user-1" }, request: { requestId: "req-1", traceId: "trace-1" } });
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});

    const result = await runtime.handleExplicitAction(ctx, {
      sessionId: session.id,
      action: { type: "generate_from_jd" },
    });
    expect(result.raw.actionResults?.[0]).toMatchObject({
      status: "needs_input",
      missingInputs: expect.arrayContaining(["jdId", "jdText"]),
    });
    await kernel.close();
  });

  it("generate_from_jd can fallback from clientState.activeJDId", async () => {
    const kernel = await createP12Kernel();
    const runtime = new AgentOrchestrator({ kernel });
    const ctx = createTestKernelContext({ user: { id: "user-1" }, request: { requestId: "req-1", traceId: "trace-1" } });
    const jd = await kernel.productServices.jdService.saveJD("user-1", {
      rawText: "React developer needed.", title: "React Dev", targetRole: "Frontend",
    });
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});

    const result = await runtime.handleExplicitAction(ctx, {
      sessionId: session.id,
      action: { type: "generate_from_jd" },
      clientState: { activeJDId: jd.id },
    });
    // Should map to the tool (creates a pending action since requiresConfirmation)
    expect(result.raw.pendingActions?.[0]).toMatchObject({ toolName: "generate_resume_from_jd" });
    await kernel.close();
  });

  it("export_resume without resumeId returns needs_input", async () => {
    const kernel = await createP12Kernel();
    const runtime = new AgentOrchestrator({ kernel });
    const ctx = createTestKernelContext({ user: { id: "user-1" }, request: { requestId: "req-1", traceId: "trace-1" } });
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});

    const result = await runtime.handleExplicitAction(ctx, {
      sessionId: session.id,
      action: { type: "export_resume" },
    });
    expect(result.raw.actionResults?.[0]).toMatchObject({
      status: "needs_input",
      missingInputs: ["resumeId"],
    });
    await kernel.close();
  });

  it("show_evidence without variantId/evidenceId/generationId in clientState returns needs_input", async () => {
    const kernel = await createP12Kernel();
    const runtime = new AgentOrchestrator({ kernel });
    const ctx = createTestKernelContext({ user: { id: "user-1" }, request: { requestId: "req-1", traceId: "trace-1" } });
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});

    const result = await runtime.handleExplicitAction(ctx, {
      sessionId: session.id,
      action: { type: "show_evidence" },
    });
    expect(result.raw.actionResults?.[0]?.status).toBe("needs_input");
    await kernel.close();
  });

  it("accept without variantId returns needs_input", async () => {
    const kernel = await createP12Kernel();
    const runtime = new AgentOrchestrator({ kernel });
    const ctx = createTestKernelContext({ user: { id: "user-1" }, request: { requestId: "req-1", traceId: "trace-1" } });
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});

    const result = await runtime.handleExplicitAction(ctx, {
      sessionId: session.id,
      action: { type: "accept" },
    });
    expect(result.raw.actionResults?.[0]).toMatchObject({
      status: "needs_input",
      missingInputs: ["variantId"],
    });
    await kernel.close();
  });

  it("reject without variantId returns needs_input", async () => {
    const kernel = await createP12Kernel();
    const runtime = new AgentOrchestrator({ kernel });
    const ctx = createTestKernelContext({ user: { id: "user-1" }, request: { requestId: "req-1", traceId: "trace-1" } });
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});

    const result = await runtime.handleExplicitAction(ctx, {
      sessionId: session.id,
      action: { type: "reject" },
    });
    expect(result.raw.actionResults?.[0]).toMatchObject({
      status: "needs_input",
      missingInputs: ["variantId"],
    });
    await kernel.close();
  });

  it("unsupported action type returns failed", async () => {
    const kernel = await createP12Kernel();
    const runtime = new AgentOrchestrator({ kernel });
    const ctx = createTestKernelContext({ user: { id: "user-1" }, request: { requestId: "req-1", traceId: "trace-1" } });
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});

    const result = await runtime.handleExplicitAction(ctx, {
      sessionId: session.id,
      action: { type: "nonexistent_action" as any },
    });
    expect(result.raw.actionResults?.[0]).toMatchObject({
      status: "failed",
      reason: "unsupported_action",
    });
    await kernel.close();
  });
});

describe("Contract: natural language chat argument hydration", () => {
  it("hydrates get_experience id from activeExperienceId in clientState", async () => {
    const kernel = await createP12Kernel();
    const { experience } = await kernel.productServices.experienceService.createExperience("user-1", {
      title: "React systems design",
      content: "Designed and built React component library used by 40 engineers.",
    });

    class HydrationTestProvider implements LLMProvider {
      public readonly name = "hydration-test";
      public async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
        const agentName = request.metadata?.agentName;
        // Frontdesk: route to experience_receiver
        if (agentName === "agent-core:frontdesk") {
          return { content: JSON.stringify({ agentName: "frontdesk", responseType: "route", routeTo: "experience_receiver", assistantMessage: "", plan: [], missingInputs: [], confidence: 0.9 }) };
        }
        // Specialist: plan get_experience without id — hydration must fill it
        return { content: JSON.stringify({ agentName: "experience_receiver", responseType: "plan", assistantMessage: "", plan: [{ id: "step-1", agentName: "experience_receiver", toolName: "get_experience", arguments: {}, summary: "Get experience." }], missingInputs: [], confidence: 0.9 }) };
      }
    }

    kernel.frontDeskModelClient = new ModelClient({
      provider: new HydrationTestProvider(),
      defaultModel: "hydration-test",
    });

    const runtime = new AgentOrchestrator({ kernel });
    const ctx = createTestKernelContext({ user: { id: "user-1" }, request: { requestId: "req-1", traceId: "trace-1" } });

    const result = await runtime.handleChat(ctx, {
      message: "优化这份经历",
      clientState: { activeExperienceId: experience.id },
    });

    // Must NOT return generic schema error about missing id
    const fullText = JSON.stringify(result);
    expect(fullText).not.toContain("缺少必填信息：id");
    expect(fullText).not.toContain("missingRequiredWithFields");
    expect(fullText).not.toContain("id is required");

    // Should have tool results, not a raw schema error
    expect(result.raw.toolResults).toBeTruthy();
    expect(Array.isArray(result.raw.toolResults)).toBe(true);

    await kernel.close();
  });

  it("hydrates update_experience experienceId from activeExperienceId", async () => {
    const kernel = await createP12Kernel();
    const { experience } = await kernel.productServices.experienceService.createExperience("user-1", {
      title: "Full-stack platform",
      content: "Built a full-stack platform for internal tools.",
    });

    class UpdateHydrationProvider implements LLMProvider {
      public readonly name = "update-hydration-test";
      public async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
        const agentName = request.metadata?.agentName;
        if (agentName === "agent-core:frontdesk") {
          return { content: JSON.stringify({ agentName: "frontdesk", responseType: "route", routeTo: "experience_receiver", assistantMessage: "", plan: [], missingInputs: [], confidence: 0.9 }) };
        }
        return { content: JSON.stringify({ agentName: "experience_receiver", responseType: "plan", assistantMessage: "", plan: [{ id: "step-1", agentName: "experience_receiver", toolName: "update_experience", arguments: { content: "优化后的内容" }, summary: "Update experience." }], missingInputs: [], confidence: 0.9 }) };
      }
    }

    kernel.frontDeskModelClient = new ModelClient({
      provider: new UpdateHydrationProvider(),
      defaultModel: "update-hydration-test",
    });

    const runtime = new AgentOrchestrator({ kernel });
    const ctx = createTestKernelContext({ user: { id: "user-1" }, request: { requestId: "req-1", traceId: "trace-1" } });

    const result = await runtime.handleChat(ctx, {
      message: "优化这份经历",
      clientState: { activeExperienceId: experience.id },
    });

    // Must NOT return generic schema error
    const fullText = JSON.stringify(result);
    expect(fullText).not.toContain("缺少必填信息：id");
    expect(fullText).not.toContain("id is required");

    // update_experience requiresConfirmation → should create a pending action
    const hasPending = result.raw.pendingActions?.some(
      (p: any) => p.toolName === "update_experience"
    );
    const isNeedsConfirmation = result.raw.actionResults?.some(
      (a: any) => a.status === "needs_confirmation"
    );
    expect(hasPending || isNeedsConfirmation).toBe(true);

    await kernel.close();
  });

  it("returns product-semantic needs_input when hydration cannot fill id", async () => {
    const kernel = await createP12Kernel();

    class MissingIdProvider implements LLMProvider {
      public readonly name = "missing-id-test";
      public async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
        const agentName = request.metadata?.agentName;
        if (agentName === "agent-core:frontdesk") {
          return { content: JSON.stringify({ agentName: "frontdesk", responseType: "route", routeTo: "experience_receiver", assistantMessage: "", plan: [], missingInputs: [], confidence: 0.9 }) };
        }
        return { content: JSON.stringify({ agentName: "experience_receiver", responseType: "plan", assistantMessage: "", plan: [{ id: "step-1", agentName: "experience_receiver", toolName: "get_experience", arguments: {}, summary: "Get experience." }], missingInputs: [], confidence: 0.9 }) };
      }
    }

    kernel.frontDeskModelClient = new ModelClient({
      provider: new MissingIdProvider(),
      defaultModel: "missing-id-test",
    });

    const runtime = new AgentOrchestrator({ kernel });
    const ctx = createTestKernelContext({ user: { id: "user-1" }, request: { requestId: "req-1", traceId: "trace-1" } });

    const result = await runtime.handleChat(ctx, {
      message: "优化这份经历",
      // No activeExperienceId — hydration can't help
    });

    // Must have a needs_input action result, not a raw schema error
    const actionResults = result.raw.actionResults ?? [];
    expect(actionResults.length).toBeGreaterThan(0);
    const firstResult = actionResults[0] as Record<string, unknown>;
    expect(firstResult.status).toBe("needs_input");

    // The message should be product-semantic, not generic "id is required"
    const messageText = JSON.stringify(result);
    expect(messageText).not.toContain("id is required");
    expect(messageText).toContain("经历");

    await kernel.close();
  });
});

describe("Contract: product generation API shapes", () => {
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

  it("POST /product/generations/from-jd returns { generationId, jd, variants, generation }", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/product/generations/from-jd",
      headers: { "x-user-id": "user-1" },
      payload: { jdText: "React developer role.", targetRole: "Frontend Engineer" },
    });
    expect(response.statusCode).toBe(200);
    const data = (response.json() as ApiSuccess<{ generationId: string; jd: unknown; variants: unknown[]; generation: unknown }>).data;
    expect(data.generationId).toMatch(/^pgen-/);
    expect(data.jd).toBeTruthy();
    expect(data.variants.length).toBeGreaterThan(0);
    // variants should have ProductVariant shape (not raw ProductGeneratedVariant)
    const variant = data.variants[0] as Record<string, unknown>;
    expect(variant.title).toBeTruthy();
    expect(variant.role).toBeTruthy();
    expect(variant.score).toBeTruthy();
    expect(variant.badges).toBeTruthy();
    expect(data.generation).toBeTruthy();
  });

  it("GET /product/generations/:id returns variants explicitly", async () => {
    const created = await server.inject({
      method: "POST",
      url: "/product/generations/from-jd",
      headers: { "x-user-id": "user-1" },
      payload: { jdText: "React developer role.", targetRole: "FE" },
    });
    const genId = (created.json() as ApiSuccess<{ generationId: string }>).data.generationId;

    const detail = await server.inject({
      method: "GET",
      url: `/product/generations/${genId}`,
      headers: { "x-user-id": "user-1" },
    });
    const data = (detail.json() as ApiSuccess<{ variants: unknown[] }>).data;
    expect(data.variants).toBeTruthy();
    expect(Array.isArray(data.variants)).toBe(true);
    expect(data.variants.length).toBeGreaterThan(0);
  });

  it("POST /product/generations/:id/accept-variant returns { generation, resume, item, variant }", async () => {
    const created = await server.inject({
      method: "POST",
      url: "/product/generations/from-jd",
      headers: { "x-user-id": "user-1" },
      payload: { jdText: "React developer role.", targetRole: "FE" },
    });
    const { generationId, variants } = (created.json() as ApiSuccess<{ generationId: string; variants: Array<{ id: string }> }>).data;

    const accept = await server.inject({
      method: "POST",
      url: `/product/generations/${generationId}/accept-variant`,
      headers: { "x-user-id": "user-1" },
      payload: { variantId: variants[0]!.id },
    });
    expect(accept.statusCode).toBe(200);
    const data = (accept.json() as ApiSuccess<{ generation: unknown; resume: unknown; item: unknown; variant: unknown }>).data;
    expect(data.generation).toBeTruthy();
    expect(data.resume).toBeTruthy();
    expect(data.item).toBeTruthy();
    expect(data.variant).toBeTruthy();
  });
});

describe("Contract: SSE completed event", () => {
  it("agent.completed event contains response at top level", async () => {
    const kernel = await createP12Kernel();
    const orchestrator = new CopilotOrchestrator({ kernel });
    const ctx = createTestKernelContext({ user: { id: "user-1" }, request: { requestId: "req-1", traceId: "trace-1" } });

    const events: Array<{ type: string; response?: unknown; payload?: { response?: unknown } }> = [];
    const response = await orchestrator.handleStream(ctx, { message: "List experiences." }, (type, data) => {
      events.push({ type, ...(data as Record<string, unknown>) });
    });

    const completed = events.find((e) => e.type === "agent.completed");
    expect(completed).toBeTruthy();
    // Must have response at top level per contract
    expect(completed?.response).toBeTruthy();
    expect((completed?.response as Record<string, unknown>)?.sessionId).toBeTruthy();
    // Also supports payload.response for backward compat
    expect(completed?.payload?.response).toBeTruthy();

    await kernel.close();
  });
});
