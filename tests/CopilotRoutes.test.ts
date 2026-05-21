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

    const unsupported = await server.inject({
      method: "POST",
      url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: { sessionId: session.id, action: { type: "accept" } },
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
