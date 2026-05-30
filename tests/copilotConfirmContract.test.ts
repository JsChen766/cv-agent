import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  delete process.env.DATABASE_URL;
}

describe("Copilot confirm contract", () => {
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

  it("generate_from_jd action returns pending action", async () => {
    // First chat to create session and ingest a JD
    const chatResponse = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: { message: "Generate resume from JD", jdText: "Vue3 TypeScript engineer needed." },
    });
    expect(chatResponse.statusCode).toBe(200);
    const chatBody = chatResponse.json() as ApiSuccess<CopilotChatResponse>;
    const sessionId = chatBody.data.sessionId;

    // Action to generate_from_jd
    const actionResponse = await server.inject({
      method: "POST",
      url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: {
        sessionId,
        action: { type: "generate_from_jd", payload: { jdText: "Vue3 TypeScript engineer needed." } },
        clientState: {},
      },
    });
    expect(actionResponse.statusCode).toBe(200);
    const actionBody = actionResponse.json() as ApiSuccess<CopilotChatResponse>;

    // Check that we got a pending action
    const pendingActionIds = actionBody.data.raw.pendingActions ?? [];
    const pendingFromActionResult = actionBody.data.raw.primaryActionResult?.pendingActionId;
    expect(pendingActionIds.length > 0 || Boolean(pendingFromActionResult)).toBe(true);
  });

  it("confirm pending action returns 200 and workspace has variants", async () => {
    // Create session
    const chatResponse = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: { message: "Generate resume from JD", jdText: "Vue3 TypeScript engineer needed." },
    });
    const chatBody = chatResponse.json() as ApiSuccess<CopilotChatResponse>;
    const sessionId = chatBody.data.sessionId;

    // Create pending action
    const actionResponse = await server.inject({
      method: "POST",
      url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: {
        sessionId,
        action: { type: "generate_from_jd", payload: { jdText: "Vue3 TypeScript engineer needed." } },
        clientState: {},
      },
    });
    const actionBody = actionResponse.json() as ApiSuccess<CopilotChatResponse>;
    const pendingId = (actionBody.data.raw.pendingActions as Array<{ id: string }> | undefined)?.[0]?.id
      ?? actionBody.data.raw.primaryActionResult?.pendingActionId;
    expect(pendingId).toBeTruthy();

    // Confirm pending action
    const confirmResponse = await server.inject({
      method: "POST",
      url: `/copilot/pending-actions/${pendingId}/confirm`,
      headers: { "x-user-id": "user-1", "content-type": "application/json" },
      payload: {},
    });
    expect(confirmResponse.statusCode).toBe(200);
    const confirmBody = confirmResponse.json();

    // Must not be a 500 error
    expect(confirmBody.ok).toBe(true);

    // Workspace must have variants
    const workspace = (confirmBody as ApiSuccess<CopilotChatResponse>).data.workspace;
    expect(workspace.variants.length).toBeGreaterThan(0);
    expect(workspace.productGenerationId).toBeTruthy();
    expect(workspace.activeVariantId).toBeTruthy();
    expect(workspace.activeVariantId).toBe(workspace.variants[0]?.id);
  });

  it("confirm response workspace has activeVariantId matching first variant", async () => {
    const chatResponse = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: { message: "Generate resume from JD", jdText: "Vue3 TypeScript engineer needed." },
    });
    const sessionId = (chatResponse.json() as ApiSuccess<CopilotChatResponse>).data.sessionId;

    const actionResponse = await server.inject({
      method: "POST",
      url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: {
        sessionId,
        action: { type: "generate_from_jd", payload: { jdText: "Vue3 TypeScript engineer needed." } },
        clientState: {},
      },
    });
    const actionBody = actionResponse.json() as ApiSuccess<CopilotChatResponse>;
    const pendingId = (actionBody.data.raw.pendingActions as Array<{ id: string }> | undefined)?.[0]?.id
      ?? actionBody.data.raw.primaryActionResult?.pendingActionId;

    const confirmResponse = await server.inject({
      method: "POST",
      url: `/copilot/pending-actions/${pendingId}/confirm`,
      headers: { "x-user-id": "user-1", "content-type": "application/json" },
      payload: {},
    });
    const workspace = (confirmResponse.json() as ApiSuccess<CopilotChatResponse>).data.workspace;

    expect(workspace.productGenerationId).toBeTruthy();
    expect(workspace.activeVariantId).toBeTruthy();
    expect(workspace.active?.variantId).toBe(workspace.activeVariantId);
    expect(workspace.variants.find((v) => v.id === workspace.activeVariantId)).toBeTruthy();
  });

  it("show_evidence after confirmed generation does not return variant not found", async () => {
    // Setup: create session, action, confirm
    const chatResponse = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: { message: "Generate resume from JD", jdText: "Vue3 TypeScript engineer needed." },
    });
    const sessionId = (chatResponse.json() as ApiSuccess<CopilotChatResponse>).data.sessionId;

    const actionResponse = await server.inject({
      method: "POST",
      url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: {
        sessionId,
        action: { type: "generate_from_jd", payload: { jdText: "Vue3 TypeScript engineer needed." } },
        clientState: {},
      },
    });
    const actionBody = actionResponse.json() as ApiSuccess<CopilotChatResponse>;
    const pendingId = (actionBody.data.raw.pendingActions as Array<{ id: string }> | undefined)?.[0]?.id
      ?? actionBody.data.raw.primaryActionResult?.pendingActionId;

    const confirmResponse = await server.inject({
      method: "POST",
      url: `/copilot/pending-actions/${pendingId}/confirm`,
      headers: { "x-user-id": "user-1", "content-type": "application/json" },
      payload: {},
    });
    const workspace = (confirmResponse.json() as ApiSuccess<CopilotChatResponse>).data.workspace;
    const variantId = workspace.variants[0]?.id;
    const generationId = workspace.productGenerationId;

    // Now test show_evidence
    const showResponse = await server.inject({
      method: "POST",
      url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: {
        sessionId,
        action: {
          type: "show_evidence",
          variantId,
          payload: { variantId, generationId },
        },
        clientState: {
          activeVariantId: variantId,
          visibleArtifactIds: [variantId],
          visibleArtifactTypes: ["variant"],
        },
      },
    });
    expect(showResponse.statusCode).toBe(200);
    const showBody = showResponse.json() as ApiSuccess<CopilotChatResponse>;

    // Should not contain "Variant not found" or "not found in current workspace"
    const assistantContent = showBody.data.assistantMessage?.content ?? "";
    expect(assistantContent).not.toContain("not found in current workspace");
    expect(assistantContent).not.toContain("not found in the current workspace");

    // Should not be 500
    expect(showBody.ok).toBe(true);
  });

  it("accept after confirmed generation does not return selected asset conflicts", async () => {
    // Setup
    const chatResponse = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: { message: "Generate resume from JD", jdText: "Vue3 TypeScript engineer needed." },
    });
    const sessionId = (chatResponse.json() as ApiSuccess<CopilotChatResponse>).data.sessionId;

    const actionResponse = await server.inject({
      method: "POST",
      url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: {
        sessionId,
        action: { type: "generate_from_jd", payload: { jdText: "Vue3 TypeScript engineer needed." } },
        clientState: {},
      },
    });
    const actionBody = actionResponse.json() as ApiSuccess<CopilotChatResponse>;
    const pendingId = (actionBody.data.raw.pendingActions as Array<{ id: string }> | undefined)?.[0]?.id
      ?? actionBody.data.raw.primaryActionResult?.pendingActionId;

    const confirmResponse = await server.inject({
      method: "POST",
      url: `/copilot/pending-actions/${pendingId}/confirm`,
      headers: { "x-user-id": "user-1", "content-type": "application/json" },
      payload: {},
    });
    const workspace = (confirmResponse.json() as ApiSuccess<CopilotChatResponse>).data.workspace;
    const variantId = workspace.variants[0]?.id;
    const generationId = workspace.productGenerationId;

    // Accept action
    const acceptResponse = await server.inject({
      method: "POST",
      url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: {
        sessionId,
        action: {
          type: "accept",
          variantId,
          payload: { variantId, generationId },
        },
        clientState: {
          activeVariantId: variantId,
          visibleArtifactIds: [variantId],
          visibleArtifactTypes: ["variant"],
        },
      },
    });
    expect(acceptResponse.statusCode).toBe(200);
    const acceptBody = acceptResponse.json() as ApiSuccess<CopilotChatResponse>;

    // Should not contain conflict errors
    const acceptContent = acceptBody.data.assistantMessage?.content ?? "";
    expect(acceptContent).not.toContain("selected asset conflicts");
    expect(acceptContent).not.toContain("conflicts with active workspace");

    // Should be either success or pending confirmation
    expect(acceptBody.ok).toBe(true);
  });

  it("confirm accept produces resumeId and workspace switches to resume_editor", async () => {
    // Full setup
    const chatResponse = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: { message: "Generate resume from JD", jdText: "Vue3 TypeScript engineer needed." },
    });
    const sessionId = (chatResponse.json() as ApiSuccess<CopilotChatResponse>).data.sessionId;

    const actionResponse = await server.inject({
      method: "POST",
      url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: {
        sessionId,
        action: { type: "generate_from_jd", payload: { jdText: "Vue3 TypeScript engineer needed." } },
        clientState: {},
      },
    });
    const actionBody = actionResponse.json() as ApiSuccess<CopilotChatResponse>;
    const genPendingId = (actionBody.data.raw.pendingActions as Array<{ id: string }> | undefined)?.[0]?.id
      ?? actionBody.data.raw.primaryActionResult?.pendingActionId;

    // Confirm generation
    const confirmGenResponse = await server.inject({
      method: "POST",
      url: `/copilot/pending-actions/${genPendingId}/confirm`,
      headers: { "x-user-id": "user-1", "content-type": "application/json" },
      payload: {},
    });
    const workspace = (confirmGenResponse.json() as ApiSuccess<CopilotChatResponse>).data.workspace;
    const variantId = workspace.variants[0]?.id;
    const generationId = workspace.productGenerationId;

    // Accept
    const acceptResponse = await server.inject({
      method: "POST",
      url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: {
        sessionId,
        action: { type: "accept", variantId, payload: { variantId, generationId } },
        clientState: { activeVariantId: variantId, visibleArtifactIds: [variantId], visibleArtifactTypes: ["variant"] },
      },
    });
    const acceptBody = acceptResponse.json() as ApiSuccess<CopilotChatResponse>;
    const acceptPendingId = (acceptBody.data.raw.pendingActions as Array<{ id: string }> | undefined)?.[0]?.id
      ?? acceptBody.data.raw.primaryActionResult?.pendingActionId;

    if (acceptPendingId) {
      const confirmAcceptResponse = await server.inject({
        method: "POST",
        url: `/copilot/pending-actions/${acceptPendingId}/confirm`,
        headers: { "x-user-id": "user-1", "content-type": "application/json" },
        payload: {},
      });
      expect(confirmAcceptResponse.statusCode).toBe(200);
      const confirmAcceptBody = confirmAcceptResponse.json() as ApiSuccess<CopilotChatResponse>;
      expect(confirmAcceptBody.ok).toBe(true);

      const acceptWorkspace = confirmAcceptBody.data.workspace;
      expect(acceptWorkspace.activePanel).toBe("resume_editor");
      expect(acceptWorkspace.resumeId).toBeTruthy();
    }
  });

  it("pending confirm with empty body does not throw 500", async () => {
    // Create a pending action ID that we can re-use from a previous test or create fresh
    const chatResponse = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: { message: "Generate resume from JD", jdText: "Vue3 TypeScript engineer needed." },
    });
    const sessionId = (chatResponse.json() as ApiSuccess<CopilotChatResponse>).data.sessionId;

    const actionResponse = await server.inject({
      method: "POST",
      url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: {
        sessionId,
        action: { type: "generate_from_jd", payload: { jdText: "Vue3 TypeScript engineer needed." } },
        clientState: {},
      },
    });
    const actionBody = actionResponse.json() as ApiSuccess<CopilotChatResponse>;
    const pendingId = (actionBody.data.raw.pendingActions as Array<{ id: string }> | undefined)?.[0]?.id
      ?? actionBody.data.raw.primaryActionResult?.pendingActionId;
    expect(pendingId).toBeTruthy();

    // Confirm with empty body
    const response = await server.inject({
      method: "POST",
      url: `/copilot/pending-actions/${pendingId}/confirm`,
      headers: { "x-user-id": "user-1", "content-type": "application/json" },
      payload: {},
    });

    // Should not be 500
    expect(response.statusCode).not.toBe(500);
    const body = response.json();
    expect(body.ok).toBe(true);
  });

  it("save_experience_from_text pending action preview uses structured draft (not raw text)", { timeout: 15000 }, async () => {
    // Chat with experience text
    const chatResponse = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: {
        message: "save experience: 基于边缘视觉的城市非机动车违规行为智能监测系统 项目负责人 2024.01 - 2025.02 基于 Python + YOLOv8 构建实时检测管线，在 3 个路口部署，违规识别准确率 92%。",
      },
    });
    expect(chatResponse.statusCode).toBe(200);
    const chatBody = chatResponse.json() as ApiSuccess<CopilotChatResponse>;

    // Verify the response has pending actions in raw
    const rawPendingActions = chatBody.data.raw?.pendingActions as Array<Record<string, unknown>> | undefined;
    // If no pending actions in raw, try fetching from pending-actions endpoint
    let pendingAction: Record<string, unknown> | undefined;
    if (rawPendingActions && rawPendingActions.length > 0) {
      pendingAction = rawPendingActions[0];
    } else {
      const paResponse = await server.inject({
        method: "GET",
        url: `/copilot/pending-actions?sessionId=${chatBody.data.sessionId}`,
        headers: { "x-user-id": "user-1" },
      });
      expect(paResponse.statusCode).toBe(200);
      const paBody = paResponse.json() as ApiSuccess<Array<Record<string, unknown>>>;
      pendingAction = paBody.data.find((a) => a.toolName === "save_experience_from_text");
    }

    // Must have a save_experience_from_text pending action
    expect(pendingAction).toBeTruthy();
    const toolName = pendingAction!.toolName as string | undefined;
    expect(toolName).toBe("save_experience_from_text");

    // Preview must exist
    const preview = pendingAction!.preview as { after?: { experienceDraft?: Record<string, unknown> } } | undefined;
    expect(preview).toBeTruthy();
    expect(preview?.after?.experienceDraft).toBeTruthy();

    const draft = preview!.after!.experienceDraft!;
    // Category should be "project" for this input
    expect(draft.category).toBe("project");
    // Title should not be generic fallback
    expect(typeof draft.title).toBe("string");
    expect(draft.title).not.toBe("Untitled experience");
    if (draft.role) expect(String(draft.role)).toContain("项目负责人");

    // Skills should include Python / YOLOv8
    const skills = Array.isArray(draft.skills) ? draft.skills as string[] : [];
    const skillLower = skills.map((s) => String(s).toLowerCase()).join(" ");
    expect(skillLower).toMatch(/python|yolov8|yolo/);

    // toolArguments should be enriched with candidate/experienceDraft
    const toolArgs = pendingAction!.toolArguments as Record<string, unknown> | undefined;
    expect(toolArgs).toBeTruthy();
    expect(toolArgs!.text).toBeTruthy();
    // In test mode with deterministic fallback, candidate should be present
    const candidate = toolArgs!.candidate;
    const expDraft = toolArgs!.experienceDraft;
    expect(candidate || expDraft).toBeTruthy();
  });
});
