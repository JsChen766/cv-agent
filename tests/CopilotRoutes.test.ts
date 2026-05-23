import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/api/createServer.js";
import type { ApiSuccess } from "../src/api/response.js";
import type { ApiKernel } from "../src/api/types.js";
import type { CopilotChatResponse } from "../src/copilot/types.js";
import { createP12Kernel } from "./p12Helpers.js";

function setupEnv() {
  process.env.AUTH_MODE = "dev_header";
  process.env.AGENT_PROVIDER = "mock";
  process.env.FRONTDESK_AGENT_MODE = "mock";
  process.env.EXPERIENCE_EXTRACTOR_MODE = "deterministic";
  process.env.ARTIFACT_GENERATOR_MODE = "deterministic";
  process.env.CRITIC_AGENT_MODE = "deterministic";
  process.env.REVISION_AGENT_MODE = "deterministic";
  process.env.NODE_ENV = "test";
  process.env.DEBUG_ROUTES_ENABLED = "true";
  delete process.env.DATABASE_URL;
}

describe("Copilot routes on agent-core runtime", () => {
  let kernel: ApiKernel;
  let server: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    setupEnv();
    kernel = await createP12Kernel();
    server = await createServer(kernel);
  });

  afterEach(async () => {
    await server.close();
    await kernel.close();
  });

  it("POST /copilot/chat returns the compatibility envelope with agentTrace", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: { message: "Show my experience library" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as ApiSuccess<CopilotChatResponse>;
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({
      sessionId: expect.any(String),
      turnId: expect.any(String),
      assistantMessage: { role: "assistant" },
      workspace: { sessionId: expect.any(String) },
      timeline: expect.any(Array),
      nextActions: expect.any(Array),
      raw: {
        artifactIds: expect.any(Array),
        evidenceChainIds: expect.any(Array),
        critiqueItemIds: expect.any(Array),
        decisionIds: expect.any(Array),
      },
    });
    expect(JSON.stringify(body.data.raw.agentTrace)).toContain("list_experiences");
  });

  it("save experience chat creates a pending action and confirm endpoint executes it", async () => {
    const save = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: { message: "Save this experience: WEEX analytics dashboard with SQL." },
    });
    const saveBody = save.json() as ApiSuccess<CopilotChatResponse>;
    const pending = saveBody.data.raw.pendingActions?.[0] as { id: string; toolName: string } | undefined;
    expect(pending).toMatchObject({ toolName: "save_experience_from_text" });
    expect(saveBody.data.raw.actionResults?.[0]).toMatchObject({
      status: "needs_confirmation",
      actionType: "save_experience_from_text",
      pendingActionId: pending?.id,
    });
    expect(await kernel.productServices.experienceService.listExperiences("user-1")).toHaveLength(0);

    const listed = await server.inject({
      method: "GET",
      url: `/copilot/pending-actions?sessionId=${saveBody.data.sessionId}`,
      headers: { "x-user-id": "user-1" },
    });
    expect((listed.json() as ApiSuccess<unknown[]>).data).toHaveLength(1);

    const confirmed = await server.inject({
      method: "POST",
      url: `/copilot/pending-actions/${pending!.id}/confirm`,
      headers: { "x-user-id": "user-1" },
    });
    expect(confirmed.statusCode).toBe(200);
    const confirmBody = confirmed.json() as ApiSuccess<CopilotChatResponse>;
    expect(confirmBody.data.raw.actionResults?.[0]?.status).toBe("success");
    expect(JSON.stringify(confirmBody.data.raw.actionResults)).not.toContain("\"needs_confirmation\"");
    expect(await kernel.productServices.experienceService.listExperiences("user-1")).toHaveLength(1);
  });

  it("POST /copilot/chat/stream emits runtime progress events before completed", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/copilot/chat/stream",
      headers: { "x-user-id": "user-1" },
      payload: { message: "Show my experience library" },
    });

    expect(response.statusCode).toBe(200);
    const events = parseSse(response.payload);
    const eventTypes = events.map((event) => event.event);
    expect(eventTypes).toContain("agent.turn.started");
    expect(eventTypes.some((type) => type === "agent.thinking" || type === "agent.route.started")).toBe(true);
    expect(eventTypes).toContain("agent.tool.started");
    expect(eventTypes).toContain("agent.tool.completed");
    expect(eventTypes.at(-1)).toBe("agent.completed");

    const completed = events.at(-1)?.data as { response?: CopilotChatResponse };
    expect(completed.response).toMatchObject({
      sessionId: expect.any(String),
      turnId: expect.any(String),
      assistantMessage: { role: "assistant" },
      workspace: { sessionId: expect.any(String) },
      raw: { agentTrace: expect.any(Object) },
    });
  });

  it("POST /copilot/chat/stream emits pending action events for confirmed tools", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/copilot/chat/stream",
      headers: { "x-user-id": "user-1" },
      payload: { message: "Save this experience: WEEX analytics dashboard with SQL." },
    });

    expect(response.statusCode).toBe(200);
    const events = parseSse(response.payload);
    const pendingEvent = events.find((event) => event.event === "agent.pending_action.created")?.data as { payload?: { pendingActionId?: string; toolName?: string } } | undefined;
    expect(events.map((event) => event.event)).toContain("agent.tool.started");
    expect(events.map((event) => event.event)).toContain("agent.tool.completed");
    expect(pendingEvent?.payload).toMatchObject({
      pendingActionId: expect.any(String),
      toolName: "save_experience_from_text",
    });

    const completed = events.find((event) => event.event === "agent.completed")?.data as { response?: CopilotChatResponse } | undefined;
    expect(completed?.response?.raw.pendingActions?.[0]).toMatchObject({ toolName: "save_experience_from_text" });
  });

  it("POST /copilot/chat/stream emits agent.failed when runtime setup fails", async () => {
    const originalSaveMessage = kernel.copilotServices.sessionService.saveMessage.bind(kernel.copilotServices.sessionService);
    kernel.copilotServices.sessionService.saveMessage = async () => {
      throw new Error("stream setup failed");
    };

    const response = await server.inject({
      method: "POST",
      url: "/copilot/chat/stream",
      headers: { "x-user-id": "user-1" },
      payload: { message: "Show my experience library" },
    });
    kernel.copilotServices.sessionService.saveMessage = originalSaveMessage;

    expect(response.statusCode).toBe(200);
    const events = parseSse(response.payload);
    expect(events.at(-1)?.event).toBe("agent.failed");
    expect(JSON.stringify(events.at(-1)?.data)).toContain("stream setup failed");
  });

  it("POST /copilot/actions uses explicit action semantics", async () => {
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});
    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "Demo resume" });

    const exportResponse = await server.inject({
      method: "POST",
      url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: {
        sessionId: session.id,
        action: { type: "export_resume" },
        clientState: { activeResumeId: resume.id },
      },
    });
    const exportBody = exportResponse.json() as ApiSuccess<CopilotChatResponse>;
    expect(exportBody.data.raw.pendingActions?.[0]).toMatchObject({ toolName: "export_resume" });
    expect(JSON.stringify(exportBody.data.raw.agentTrace)).not.toContain("Classifying and routing");

    // needs_input for missing variantId on a supported action
    const needsInput = await server.inject({
      method: "POST",
      url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: { sessionId: session.id, action: { type: "accept" } },
    });
    const needsInputBody = needsInput.json() as ApiSuccess<CopilotChatResponse>;
    expect(needsInputBody.data.raw.actionResults?.[0]).toMatchObject({ status: "needs_input", missingInputs: ["variantId"] });

    // truly unsupported action type
    const unsupported = await server.inject({
      method: "POST",
      url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: { sessionId: session.id, action: { type: "unknown_fake_action" } as any },
    });
    const unsupportedBody = unsupported.json() as ApiSuccess<CopilotChatResponse>;
    expect(unsupportedBody.data.raw.actionResults?.[0]).toMatchObject({ status: "failed", reason: "unsupported_action" });
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

  it("agent.completed event contains complete response in both response and payload.response", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/copilot/chat/stream",
      headers: { "x-user-id": "user-1" },
      payload: { message: "Show my experience library" },
    });

    expect(response.statusCode).toBe(200);
    const events = parseSse(response.payload);
    const completed = events.find((e) => e.event === "agent.completed")?.data as Record<string, unknown> | undefined;
    expect(completed).toBeDefined();
    expect(completed!.type).toBe("agent.completed");
    expect(completed!.sessionId).toEqual(expect.any(String));
    expect(completed!.turnId).toEqual(expect.any(String));
    expect(completed!.createdAt).toEqual(expect.any(String));
    expect(completed!.label).toEqual(expect.any(String));

    // response at top level
    const topResponse = completed!.response as Record<string, unknown> | undefined;
    expect(topResponse).toBeDefined();
    expect(topResponse!.sessionId).toEqual(expect.any(String));
    expect(topResponse!.assistantMessage).toBeDefined();

    // payload.response also present for frontend compat
    const payload = completed!.payload as Record<string, unknown> | undefined;
    expect(payload).toBeDefined();
    const payloadResponse = payload!.response as Record<string, unknown> | undefined;
    expect(payloadResponse).toBeDefined();
    expect(payloadResponse!.sessionId).toEqual(topResponse!.sessionId);
  });

  it("stream event names match data.type", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/copilot/chat/stream",
      headers: { "x-user-id": "user-1" },
      payload: { message: "Show my experience library" },
    });

    expect(response.statusCode).toBe(200);
    const events = parseSse(response.payload);
    for (const entry of events) {
      if (!entry.event) continue;
      const data = entry.data as Record<string, unknown> | undefined;
      if (data && typeof data.type === "string") {
        expect(entry.event).toBe(data.type);
      }
    }
  });

  it("GET /copilot/sessions/:id returns session detail", async () => {
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {
      targetRole: "Test Role",
    });

    const response = await server.inject({
      method: "GET",
      url: `/copilot/sessions/${session.id}`,
      headers: { "x-user-id": "user-1" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as ApiSuccess<Record<string, unknown>>;
    const data = body.data;
    expect(data.session).toBeDefined();
    expect((data.session as Record<string, unknown>).id).toBe(session.id);
    expect(Array.isArray(data.messages)).toBe(true);
    expect(data.turns).toBeDefined();
    expect(Array.isArray(data.turns)).toBe(true);
  });

  it("GET /copilot/sessions/:id normalizes turn Date completedAt without warnings", async () => {
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});

    const original = kernel.copilotServices.sessionService.listTurns.bind(kernel.copilotServices.sessionService);
    kernel.copilotServices.sessionService.listTurns = async () => [{
      id: "ct-date",
      sessionId: session.id,
      userMessageId: "msg-user",
      assistantMessageId: null,
      status: "completed",
      createdAt: "2024-01-01T00:00:00.000Z",
      completedAt: new Date("2024-01-01T00:00:00.000Z"),
      error: null,
    } as unknown as Awaited<ReturnType<typeof original>>[number]];

    try {
      const response = await server.inject({
        method: "GET",
        url: `/copilot/sessions/${session.id}`,
        headers: { "x-user-id": "user-1" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as ApiSuccess<Record<string, unknown>>;
      expect(body.data.detailWarnings).toBeUndefined();
      expect(body.data.turns).toEqual([
        expect.objectContaining({
          id: "ct-date",
          completedAt: "2024-01-01T00:00:00.000Z",
          assistantMessageId: null,
        }),
      ]);
    } finally {
      kernel.copilotServices.sessionService.listTurns = original;
    }
  });

  it("GET /copilot/sessions/:id returns 404 for missing session", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/copilot/sessions/nonexistent",
      headers: { "x-user-id": "user-1" },
    });

    expect(response.statusCode).toBe(404);
  });

  it("GET /copilot/sessions/:id returns 200 with detailWarnings when messages fail", async () => {
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});

    const original = kernel.copilotServices.sessionService.listMessages.bind(kernel.copilotServices.sessionService);
    kernel.copilotServices.sessionService.listMessages = async () => {
      throw new Error("messages load failed");
    };

    try {
      const response = await server.inject({
        method: "GET",
        url: `/copilot/sessions/${session.id}`,
        headers: { "x-user-id": "user-1" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as ApiSuccess<Record<string, unknown>>;
      expect(Array.isArray(body.data.messages)).toBe(true);
      expect((body.data.messages as unknown[]).length).toBe(0);
      const warnings = body.data.detailWarnings as Array<{ source: string }> | undefined;
      expect(warnings).toBeDefined();
      expect(warnings!.some((w) => w.source === "messages")).toBe(true);
    } finally {
      kernel.copilotServices.sessionService.listMessages = original;
    }
  });

  it("GET /copilot/sessions/:id returns 200 with workspace null when workspace fails", async () => {
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});

    const original = kernel.copilotServices.workspaceService.getWorkspace.bind(kernel.copilotServices.workspaceService);
    kernel.copilotServices.workspaceService.getWorkspace = async () => {
      throw new Error("workspace load failed");
    };

    try {
      const response = await server.inject({
        method: "GET",
        url: `/copilot/sessions/${session.id}`,
        headers: { "x-user-id": "user-1" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as ApiSuccess<Record<string, unknown>>;
      expect(body.data.workspace).toBeNull();
      const warnings = body.data.detailWarnings as Array<{ source: string }> | undefined;
      expect(warnings).toBeDefined();
      expect(warnings!.some((w) => w.source === "workspace")).toBe(true);
    } finally {
      kernel.copilotServices.workspaceService.getWorkspace = original;
    }
  });

  it("GET /copilot/sessions/:id returns 200 with empty turns when turns fail", async () => {
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});

    const original = kernel.copilotServices.sessionService.listTurns.bind(kernel.copilotServices.sessionService);
    kernel.copilotServices.sessionService.listTurns = async () => {
      throw new Error("turns load failed");
    };

    try {
      const response = await server.inject({
        method: "GET",
        url: `/copilot/sessions/${session.id}`,
        headers: { "x-user-id": "user-1" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as ApiSuccess<Record<string, unknown>>;
      expect(Array.isArray(body.data.turns)).toBe(true);
      expect((body.data.turns as unknown[]).length).toBe(0);
      const warnings = body.data.detailWarnings as Array<{ source: string }> | undefined;
      expect(warnings).toBeDefined();
      expect(warnings!.some((w) => w.source === "turns")).toBe(true);
    } finally {
      kernel.copilotServices.sessionService.listTurns = original;
    }
  });

  it("confirming generate_resume_from_jd returns variants in workspace and raw tool results", async () => {
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});

    const actionResponse = await server.inject({
      method: "POST",
      url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: {
        sessionId: session.id,
        action: { type: "generate_from_jd", payload: { jdText: "React TypeScript performance role.", targetRole: "Frontend Engineer" } },
      },
    });
    expect(actionResponse.statusCode).toBe(200);
    const actionBody = actionResponse.json() as ApiSuccess<CopilotChatResponse>;
    const pending = actionBody.data.raw.pendingActions?.[0] as { id: string; toolName: string } | undefined;
    expect(pending).toMatchObject({ toolName: "generate_resume_from_jd" });

    const confirmed = await server.inject({
      method: "POST",
      url: `/copilot/pending-actions/${pending!.id}/confirm`,
      headers: { "x-user-id": "user-1" },
    });

    expect(confirmed.statusCode).toBe(200);
    const confirmBody = confirmed.json() as ApiSuccess<CopilotChatResponse>;
    expect(confirmBody.data.workspace.variants.length).toBeGreaterThan(0);
    expect(confirmBody.data.workspace.productGenerationId).toEqual(expect.any(String));
    expect(confirmBody.data.workspace.jdId).toEqual(expect.any(String));
    expect(confirmBody.data.assistantMessage.content).toContain("已基于 JD 生成");
    expect(confirmBody.data.raw.toolResults?.[0]).toMatchObject({
      status: "success",
      data: {
        generationId: expect.any(String),
        variants: expect.any(Array),
      },
      workspacePatch: {
        productGenerationId: expect.any(String),
        variants: expect.any(Array),
      },
    });
    expect(confirmBody.data.raw.actionResults?.[0]).toMatchObject({
      status: "success",
      actionType: "generate_resume_from_jd",
      metadata: {
        generationId: expect.any(String),
        variantCount: expect.any(Number),
      },
    });
  });
});

function parseSse(payload: string): Array<{ event: string; data: unknown }> {
  return payload
    .trim()
    .split(/\n\n/)
    .filter(Boolean)
    .map((chunk) => {
      const event = chunk.match(/^event: (.+)$/m)?.[1] ?? "";
      const dataText = chunk.match(/^data: (.+)$/m)?.[1] ?? "{}";
      return { event, data: JSON.parse(dataText) as unknown };
    });
}
