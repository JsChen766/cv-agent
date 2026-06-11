import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/api/createServer.js";
import { AgentOrchestrator } from "../src/agent-core/runtime/AgentOrchestrator.js";
import type { ToolDefinition } from "../src/agent-core/tools/Tool.js";
import type { ApiSuccess } from "../src/api/response.js";
import type { ApiKernel } from "../src/api/types.js";
import type { CopilotChatResponse } from "../src/copilot/types.js";
import { createP12Kernel } from "./p12Helpers.js";

describe("generate resume pending-action flow", () => {
  let kernel: ApiKernel;
  let server: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    process.env.CONFIRM_EXPORT_RENDER_TIMEOUT_MS = "25";
    kernel = await createP12Kernel();
    server = await createServer(kernel);
  });

  afterEach(async () => {
    delete process.env.CONFIRM_EXPORT_RENDER_TIMEOUT_MS;
    vi.restoreAllMocks();
    await server.close();
    await kernel.close();
  });

  it("first generate request creates one pending action, confirmation succeeds, and repeated requests do not loop confirmation", async () => {
    const bootstrap = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: { message: "先开始会话" },
    });
    expect(bootstrap.statusCode).toBe(200);
    const bootstrapBody = bootstrap.json() as ApiSuccess<CopilotChatResponse>;

    const actionResponse = await server.inject({
      method: "POST",
      url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: {
        sessionId: bootstrapBody.data.sessionId,
        action: {
          type: "generate_from_jd",
          payload: {
            jdText: "Frontend JD with Vue3 + TypeScript and dashboard delivery.",
            targetRole: "Frontend Engineer",
          },
        },
      },
    });
    expect(actionResponse.statusCode).toBe(200);
    const actionBody = actionResponse.json() as ApiSuccess<CopilotChatResponse>;
    const pendingActions = (actionBody.data.raw.pendingActions ?? []) as Array<{ id: string; toolName?: string }>;
    expect(pendingActions.filter((item) => item.toolName === "generate_resume_from_jd")).toHaveLength(1);
    const pendingId = pendingActions[0]?.id;
    expect(typeof pendingId).toBe("string");

    const duplicateWhilePending = await server.inject({
      method: "POST",
      url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: {
        sessionId: actionBody.data.sessionId,
        action: {
          type: "generate_from_jd",
          payload: {
            jdText: "Frontend JD with Vue3 + TypeScript and dashboard delivery.",
            targetRole: "Frontend Engineer",
          },
        },
      },
    });
    expect(duplicateWhilePending.statusCode).toBe(200);
    const duplicatePendingBody = duplicateWhilePending.json() as ApiSuccess<CopilotChatResponse>;
    const duplicatePendingId = (duplicatePendingBody.data.raw.pendingActions as Array<{ id?: string }> | undefined)?.[0]?.id
      ?? (duplicatePendingBody.data.raw.actionResults as Array<{ actionType?: string; pendingActionId?: string }> | undefined)
        ?.find((item) => item.actionType === "generate_resume_from_jd")
        ?.pendingActionId;
    expect(duplicatePendingId).toBe(pendingId);

    const confirm = await server.inject({
      method: "POST",
      url: `/copilot/pending-actions/${pendingId}/confirm`,
      headers: { "x-user-id": "user-1" },
    });
    expect(confirm.statusCode).toBe(200);
    const confirmBody = confirm.json() as ApiSuccess<CopilotChatResponse>;
    expect(confirmBody.data.assistantMessage.kind).not.toBe("clarifying_question");
    expect(confirmBody.data.raw.pendingActions ?? []).toHaveLength(0);
    expect((confirmBody.data.raw.actionResults ?? []).some((item) => item.status === "needs_confirmation")).toBe(false);
    expect(((confirmBody.data.raw.toolResults ?? []) as Array<{ actionResult?: { status?: string } }>).some((item) => item.actionResult?.status === "needs_confirmation")).toBe(false);

    const confirmAgain = await server.inject({
      method: "POST",
      url: `/copilot/pending-actions/${pendingId}/confirm`,
      headers: { "x-user-id": "user-1" },
    });
    expect(confirmAgain.statusCode).toBe(200);
    const confirmAgainBody = confirmAgain.json() as ApiSuccess<CopilotChatResponse>;
    expect(confirmAgainBody.data.raw.pendingActions ?? []).toHaveLength(0);
    expect((confirmAgainBody.data.raw.actionResults ?? []).some((item) => item.status === "needs_confirmation")).toBe(false);

    const duplicateAfterExecuted = await server.inject({
      method: "POST",
      url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: {
        sessionId: actionBody.data.sessionId,
        action: {
          type: "generate_from_jd",
          payload: {
            jdText: "Frontend JD with Vue3 + TypeScript and dashboard delivery.",
            targetRole: "Frontend Engineer",
          },
        },
      },
    });
    expect(duplicateAfterExecuted.statusCode).toBe(200);
    const duplicateExecutedBody = duplicateAfterExecuted.json() as ApiSuccess<CopilotChatResponse>;
    expect(duplicateExecutedBody.data.raw.pendingActions ?? []).toHaveLength(0);
    expect((duplicateExecutedBody.data.raw.actionResults ?? []).some((item) => item.status === "needs_confirmation")).toBe(false);
  });

  it("updatePendingActionDisplayStatus synchronizes displaySnapshot and stored product blocks", async () => {
    const runtime = new AgentOrchestrator({ kernel });
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});
    const tool = runtime.tools.get("generate_resume_from_jd") as ToolDefinition | undefined;
    expect(tool).toBeTruthy();

    const pending = await runtime.pendingActions.create({
      userId: "user-1",
      sessionId: session.id,
      turnId: "ct-sync-1",
      tool: tool!,
      toolArguments: { jdText: "same jd text", jdHash: "hash-1" },
      title: "生成简历",
      summary: "需要你确认后继续执行。",
      preview: { before: { text: "draft" } },
    });

    await kernel.copilotServices.sessionService.saveMessage("user-1", {
      id: "msg-sync-1",
      sessionId: session.id,
      turnId: "ct-sync-1",
      role: "assistant",
      content: "请确认后继续执行。",
      kind: "clarifying_question",
      createdAt: new Date().toISOString(),
      metadata: {
        productBlocks: [{
          type: "pending_action",
          payload: {
            action: {
              id: pending.id,
              status: "pending",
              title: "生成简历",
              summary: "需要你确认后继续执行。",
              riskLevel: "medium",
              preview: { before: { text: "draft" } },
            },
          },
        }] as unknown as any[],
        displaySnapshot: {
          pendingActions: [{
            id: pending.id,
            toolName: "generate_resume_from_jd",
            title: "生成简历",
            summary: "需要你确认后继续执行。",
            riskLevel: "medium",
            status: "pending",
            createdAt: pending.createdAt,
            preview: { before: { text: "draft" } },
          }],
          productBlocks: [{
            type: "pending_action",
            payload: {
              action: {
                id: pending.id,
                status: "pending",
                title: "生成简历",
                summary: "需要你确认后继续执行。",
                riskLevel: "medium",
                preview: { before: { text: "draft" } },
              },
            },
          }] as unknown as any[],
        },
      },
    });

    await (runtime as any).updatePendingActionDisplayStatus("user-1", pending.id, "executed");

    const messages = await kernel.copilotServices.sessionService.listMessages("user-1", session.id, 20);
    const assistant = messages.find((item) => item.id === "msg-sync-1");
    expect(assistant).toBeTruthy();
    const metadata = assistant?.metadata as Record<string, unknown>;
    const snapshot = metadata.displaySnapshot as Record<string, unknown>;
    const snapshotPending = (snapshot.pendingActions as Array<Record<string, unknown>>)[0];
    expect(snapshotPending.status).toBe("executed");
    expect(snapshotPending.preview).toEqual({ before: { text: "draft" } });

    const metadataBlock = (metadata.productBlocks as Array<Record<string, unknown>>)[0];
    const metadataAction = ((metadataBlock.payload as Record<string, unknown>).action as Record<string, unknown>);
    expect(metadataAction.status).toBe("executed");
    expect(metadataAction.title).toBe("生成简历");
    expect(metadataAction.preview).toEqual({ before: { text: "draft" } });

    const snapshotBlock = ((snapshot.productBlocks as Array<Record<string, unknown>>)[0].payload as Record<string, unknown>);
    const snapshotAction = snapshotBlock.action as Record<string, unknown>;
    expect(snapshotAction.status).toBe("executed");
    expect(snapshotAction.riskLevel).toBe("medium");
  });

  it("confirm generation returns a background job without synchronously generating or exporting", async () => {
    const createExportSpy = vi.spyOn(kernel.exportService, "createExport");
    vi.spyOn(kernel.exportService, "renderExportJob").mockImplementation(() => new Promise(() => undefined));
    const generateSpy = vi.spyOn(kernel.productServices.generationProductService, "generateResumeFromJD");

    const bootstrap = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: { message: "start" },
    });
    const sessionId = (bootstrap.json() as ApiSuccess<CopilotChatResponse>).data.sessionId;

    const actionResponse = await server.inject({
      method: "POST",
      url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: {
        sessionId,
        action: {
          type: "generate_from_jd",
          payload: {
            jdText: "Frontend JD with Vue3 + TypeScript and dashboard delivery.",
            targetRole: "Frontend Engineer",
          },
        },
      },
    });
    const actionBody = actionResponse.json() as ApiSuccess<CopilotChatResponse>;
    const pendingId = (actionBody.data.raw.pendingActions as Array<{ id: string }> | undefined)?.[0]?.id;
    expect(pendingId).toBeTruthy();

    const startedAt = Date.now();
    const confirm = await server.inject({
      method: "POST",
      url: `/copilot/pending-actions/${pendingId}/confirm`,
      headers: { "x-user-id": "user-1" },
    });
    const elapsedMs = Date.now() - startedAt;
    expect(confirm.statusCode).toBe(200);
    expect(elapsedMs).toBeLessThan(1000);

    const body = confirm.json() as ApiSuccess<CopilotChatResponse>;
    expect(body.data.raw.pendingActions ?? []).toHaveLength(0);
    expect(body.data.workspace.status).toBe("generating");
    expect(body.data.workspace.variants.length).toBe(0);
    const generationAction = body.data.raw.actionResults?.find((item) => item.actionType === "generate_resume_from_jd" && item.status === "success");
    const jobId = generationAction?.metadata?.jobId;
    expect(typeof jobId).toBe("string");
    expect(generationAction?.metadata?.generating).toBe(true);
    expect(generateSpy).not.toHaveBeenCalled();
    expect(body.data.raw.actionResults?.some((item) => item.actionType === "export_resume")).toBe(false);
    expect(body.data.workspace.exportRecords ?? []).toHaveLength(0);
    expect(createExportSpy).not.toHaveBeenCalled();
    expect(kernel.exportService.renderExportJob).not.toHaveBeenCalled();

    await kernel.jobRunner.runJob(String(jobId), "user-1");
    expect(generateSpy).toHaveBeenCalledTimes(1);
    const job = await kernel.platformServices.backgroundJobs.getJob("user-1", String(jobId));
    expect(job).toMatchObject({
      status: "completed",
      type: "long_generation",
    });
    expect(job?.output?.generationId).toEqual(expect.any(String));
    expect(job?.output?.variantCount).toBeGreaterThan(0);
  });

  it("after long_generation job completes, GET /copilot/sessions/:id returns persisted productGenerationId, variants, activeVariantId and non-generating status", async () => {
    vi.spyOn(kernel.exportService, "renderExportJob").mockImplementation(() => new Promise(() => undefined));

    const bootstrap = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: { message: "start" },
    });
    const sessionId = (bootstrap.json() as ApiSuccess<CopilotChatResponse>).data.sessionId;

    const actionResponse = await server.inject({
      method: "POST",
      url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: {
        sessionId,
        action: {
          type: "generate_from_jd",
          payload: {
            jdText: "Frontend JD with Vue3 + TypeScript and dashboard delivery.",
            targetRole: "Frontend Engineer",
          },
        },
      },
    });
    const actionBody = actionResponse.json() as ApiSuccess<CopilotChatResponse>;
    const pendingId = (actionBody.data.raw.pendingActions as Array<{ id: string }> | undefined)?.[0]?.id;
    expect(pendingId).toBeTruthy();

    const confirm = await server.inject({
      method: "POST",
      url: `/copilot/pending-actions/${pendingId}/confirm`,
      headers: { "x-user-id": "user-1" },
    });
    expect(confirm.statusCode).toBe(200);
    const confirmBody = confirm.json() as ApiSuccess<CopilotChatResponse>;
    expect(confirmBody.data.workspace.status).toBe("generating");
    expect(confirmBody.data.workspace.variants).toHaveLength(0);
    const jobId = confirmBody.data.raw.actionResults
      ?.find((item) => item.actionType === "generate_resume_from_jd" && item.status === "success")
      ?.metadata?.jobId;
    expect(typeof jobId).toBe("string");

    // Pre-completion: session GET reports stuck "generating" state with no variants
    const beforeDetail = await server.inject({
      method: "GET",
      url: `/copilot/sessions/${sessionId}`,
      headers: { "x-user-id": "user-1" },
    });
    expect(beforeDetail.statusCode).toBe(200);
    const beforeBody = beforeDetail.json() as ApiSuccess<{ workspace: Record<string, unknown> | null }>;
    const beforeWorkspace = beforeBody.data.workspace;
    expect(beforeWorkspace?.status).toBe("generating");
    expect(beforeWorkspace?.productGenerationId ?? null).toBeNull();
    expect((beforeWorkspace?.variants as unknown[] | undefined) ?? []).toHaveLength(0);

    // Run the background job
    await kernel.jobRunner.runJob(String(jobId), "user-1");

    const job = await kernel.platformServices.backgroundJobs.getJob("user-1", String(jobId));
    expect(job?.status).toBe("completed");
    const completedGenerationId = (job?.output as Record<string, unknown> | undefined)?.generationId;
    expect(typeof completedGenerationId).toBe("string");

    // /jobs/:jobId still exposes completed output (existing API preserved)
    expect((job?.output as Record<string, unknown>).variantCount).toBeGreaterThan(0);
    // /product/generations/:generationId still resolves the generation detail
    const generation = await kernel.productServices.generationProductService.getGeneration("user-1", String(completedGenerationId));
    expect(generation?.id).toBe(completedGenerationId);
    expect(generation?.outputSnapshot?.variants?.length ?? 0).toBeGreaterThan(0);

    // Post-completion: session GET reflects persisted workspace (refresh/restore works)
    const afterDetail = await server.inject({
      method: "GET",
      url: `/copilot/sessions/${sessionId}`,
      headers: { "x-user-id": "user-1" },
    });
    expect(afterDetail.statusCode).toBe(200);
    const afterBody = afterDetail.json() as ApiSuccess<{ workspace: Record<string, unknown> | null }>;
    const afterWorkspace = afterBody.data.workspace;
    expect(afterWorkspace).toBeTruthy();
    expect(afterWorkspace?.status).not.toBe("generating");
    expect(afterWorkspace?.status).toBe("ready");
    expect(afterWorkspace?.productGenerationId).toBe(completedGenerationId);
    const persistedVariants = afterWorkspace?.variants as Array<{ id: string }> | undefined;
    expect(persistedVariants && persistedVariants.length).toBeGreaterThan(0);
    expect(typeof afterWorkspace?.activeVariantId).toBe("string");
    expect(persistedVariants?.[0]?.id).toBe(afterWorkspace?.activeVariantId);
  });

  it("accept_generation_variant still works after job completion and does not auto-export", async () => {
    vi.spyOn(kernel.exportService, "renderExportJob").mockImplementation(() => new Promise(() => undefined));
    const createExportSpy = vi.spyOn(kernel.exportService, "createExport");

    const bootstrap = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: { message: "start" },
    });
    const sessionId = (bootstrap.json() as ApiSuccess<CopilotChatResponse>).data.sessionId;

    const actionResponse = await server.inject({
      method: "POST",
      url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: {
        sessionId,
        action: {
          type: "generate_from_jd",
          payload: {
            jdText: "Frontend JD with Vue3 + TypeScript and dashboard delivery.",
            targetRole: "Frontend Engineer",
          },
        },
      },
    });
    const pendingId = ((actionResponse.json() as ApiSuccess<CopilotChatResponse>).data.raw.pendingActions as Array<{ id: string }> | undefined)?.[0]?.id;
    expect(pendingId).toBeTruthy();

    const confirm = await server.inject({
      method: "POST",
      url: `/copilot/pending-actions/${pendingId}/confirm`,
      headers: { "x-user-id": "user-1" },
    });
    const jobId = (confirm.json() as ApiSuccess<CopilotChatResponse>).data.raw.actionResults
      ?.find((item) => item.actionType === "generate_resume_from_jd" && item.status === "success")
      ?.metadata?.jobId;

    await kernel.jobRunner.runJob(String(jobId), "user-1");
    expect(createExportSpy).not.toHaveBeenCalled();

    const detail = await server.inject({
      method: "GET",
      url: `/copilot/sessions/${sessionId}`,
      headers: { "x-user-id": "user-1" },
    });
    const workspace = (detail.json() as ApiSuccess<{ workspace: Record<string, unknown> }>).data.workspace;
    const variantId = (workspace.variants as Array<{ id: string }>)[0]?.id;
    const generationId = workspace.productGenerationId as string;
    expect(variantId).toBeTruthy();
    expect(generationId).toBeTruthy();

    // Explicit accept_generation_variant via product service contract (no auto export)
    const acceptResult = await kernel.productServices.generationProductService.saveAcceptedVariantToResume("user-1", {
      generationId,
      variantId,
    });
    expect(acceptResult.resume.id).toBeTruthy();
    expect(createExportSpy).not.toHaveBeenCalled();
  });
});
