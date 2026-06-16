import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createServer } from "../src/api/createServer.js";
import { createTestKernelContext } from "../src/api/context.js";
import type { ApiSuccess } from "../src/api/response.js";
import type { ApiKernel } from "../src/api/types.js";
import { AgentOrchestrator } from "../src/agent-core/runtime/AgentOrchestrator.js";
import type { ToolDefinition } from "../src/agent-core/tools/Tool.js";
import { ToolResultSchema } from "../src/agent-core/validation/ToolInputSchemas.js";
import { AgentDecisionSchema, AgentNameSchema, type AgentName } from "../src/agent-core/validation/AgentOutputSchemas.js";
import { careerDomain } from "../src/agent-domains/career/index.js";
import type { CopilotChatResponse, ProductBlock } from "../src/copilot/types.js";
import { createP12Kernel } from "./p12Helpers.js";

describe("Phase 0 agent contract freeze", () => {
  let kernel: ApiKernel;
  let server: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    process.env.AUTH_MODE = "dev_header";
    process.env.NODE_ENV = "test";
    delete process.env.DATABASE_URL;

    kernel = await createP12Kernel();
    server = await createServer(kernel);
  });

  afterEach(async () => {
    await server.close();
    await kernel.close();
  });

  it("keeps POST /copilot/chat response envelope, metadata, display snapshot, and raw debug contract compatible", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "phase0-user" },
      payload: { message: "Show my experience library" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as ApiSuccess<CopilotChatResponse>;
    expect(body.ok).toBe(true);
    assertCopilotResponseContract(body.data);

    expect(body.data.raw).toMatchObject({
      artifactIds: expect.any(Array),
      evidenceChainIds: expect.any(Array),
      critiqueItemIds: expect.any(Array),
      decisionIds: expect.any(Array),
      agentTrace: expect.any(Object),
      toolResults: expect.any(Array),
      actionResults: expect.any(Array),
    });

    const metadata = body.data.assistantMessage.metadata;
    expect(metadata?.productBlocks).toEqual(expect.any(Array));
    expect(metadata?.displaySnapshot).toEqual(expect.any(Object));
    expect(metadata?.displaySnapshot?.productBlocks).toEqual(expect.any(Array));
    expect(metadata?.displaySnapshot?.toolResults).toEqual(expect.any(Array));
  });

  it("keeps POST /copilot/actions explicit action mapping out of chat routing and returns action contract fields", async () => {
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("phase0-user", {});
    const resume = await kernel.productServices.resumeService.createResume("phase0-user", { title: "Phase 0 resume" });

    const response = await server.inject({
      method: "POST",
      url: "/copilot/actions",
      headers: { "x-user-id": "phase0-user" },
      payload: {
        sessionId: session.id,
        action: { type: "export_resume" },
        clientState: { activeResumeId: resume.id },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as ApiSuccess<CopilotChatResponse>;
    expect(body.ok).toBe(true);
    assertCopilotResponseContract(body.data);
    expect(body.data.raw.pendingActions?.[0]).toMatchObject({
      id: expect.any(String),
      toolName: "export_resume",
      status: "pending",
    });
    expect(body.data.raw.actionResults?.[0]).toMatchObject({
      actionType: "export_resume",
      status: "needs_confirmation",
      pendingActionId: expect.any(String),
    });
    expect(JSON.stringify(body.data.raw.agentTrace)).not.toContain("Classifying and routing");
  });

  it("keeps pending action confirmation response compatible and idempotent for repeated confirmation", async () => {
    const save = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "phase0-user" },
      payload: { message: "Save this experience: Phase 0 contract freeze with TypeScript tests." },
    });
    expect(save.statusCode).toBe(200);
    const saveBody = save.json() as ApiSuccess<CopilotChatResponse>;
    const pendingId = (saveBody.data.raw.pendingActions as Array<{ id: string }> | undefined)?.[0]?.id;
    expect(pendingId).toEqual(expect.any(String));

    const confirmed = await server.inject({
      method: "POST",
      url: `/copilot/pending-actions/${pendingId}/confirm`,
      headers: { "x-user-id": "phase0-user", "content-type": "application/json" },
      payload: {},
    });

    expect(confirmed.statusCode).toBe(200);
    const confirmBody = confirmed.json() as ApiSuccess<CopilotChatResponse>;
    expect(confirmBody.ok).toBe(true);
    assertCopilotResponseContract(confirmBody.data);
    expect(confirmBody.data.raw.actionResults?.[0]).toMatchObject({
      actionType: "save_experience_from_text",
      status: "success",
    });
    expect(confirmBody.data.raw.pendingActions ?? []).toHaveLength(0);

    const repeated = await server.inject({
      method: "POST",
      url: `/copilot/pending-actions/${pendingId}/confirm`,
      headers: { "x-user-id": "phase0-user", "content-type": "application/json" },
      payload: {},
    });
    expect(repeated.statusCode).toBe(200);
    expect((repeated.json() as ApiSuccess<CopilotChatResponse>).ok).toBe(true);
  });

  it("keeps AgentOrchestrator handleChat, handleExplicitAction, and confirmPendingAction smoke contracts", async () => {
    const runtime = new AgentOrchestrator({ kernel, pendingActions: kernel.pendingActions });
    const ctx = createTestKernelContext({ user: { id: "phase0-runtime-user" }, request: { requestId: "phase0-req", traceId: "phase0-trace" } });

    const chat = await runtime.handleChat(ctx, { message: "Show my experience library" });
    assertCopilotResponseContract(chat);
    expect(chat.raw.agentTrace).toEqual(expect.any(Object));

    const action = await runtime.handleExplicitAction(ctx, {
      sessionId: chat.sessionId,
      action: { type: "generate_from_jd", payload: { jdText: "TypeScript runtime engineer." } },
    });
    assertCopilotResponseContract(action);
    const pendingId = (action.raw.pendingActions as Array<{ id: string }> | undefined)?.[0]?.id
      ?? action.raw.primaryActionResult?.pendingActionId;
    expect(pendingId).toEqual(expect.any(String));

    const confirmed = await runtime.confirmPendingAction(ctx, pendingId!);
    assertCopilotResponseContract(confirmed);
    expect(confirmed.raw.actionResults?.[0]).toMatchObject({
      actionType: "generate_resume_from_jd",
      status: "success",
    });
  });

  it("keeps AgentDecisionSchema accepting the existing five agent names and decision shapes", () => {
    expect(AgentNameSchema.options).toEqual([
      "frontdesk",
      "experience_receiver",
      "strategist",
      "architect",
      "critic",
    ]);

    for (const agentName of AgentNameSchema.options) {
      const decision = AgentDecisionSchema.parse({
        agentName,
        responseType: "plan",
        assistantMessage: "",
        plan: [
          {
            id: `step-${agentName}`,
            agentName,
            toolName: "list_experiences",
            arguments: {},
            summary: "Smoke plan step.",
          },
        ],
        missingInputs: [],
        confidence: 0.9,
      });
      expect(decision.agentName).toBe(agentName);
      expect(decision.plan[0]?.agentName).toBe(agentName);
    }

    expect(AgentDecisionSchema.parse({
      agentName: "critic",
      responseType: "final",
      assistantMessage: "Pass.",
      plan: [],
      missingInputs: [],
      confidence: 1,
      criticReview: {
        verdict: "pass",
        riskLevel: "low",
        unsupportedClaims: [],
        missingEvidence: [],
        suggestedFixes: [],
        userVisibleSummary: "Pass.",
      },
    }).criticReview?.verdict).toBe("pass");
  });

  it("keeps ToolDefinition and ToolResult fields compatible across the career domain tools", () => {
    const tools = careerDomain.tools ?? [];
    expect(tools.length).toBeGreaterThan(0);

    for (const tool of tools) {
      assertToolDefinitionContract(tool);
      expect(tool.outputSchema.safeParse({
        status: "success",
        message: "ok",
        data: {},
        workspacePatch: {},
        actionResult: { actionType: tool.name, status: "success" },
      }).success).toBe(true);
    }

    expect(ToolResultSchema.parse({
      status: "needs_input",
      message: "Missing input.",
      actionResult: { actionType: "show_evidence", status: "needs_input" },
      visibility: "action_required",
    })).toMatchObject({ status: "needs_input" });
  });

  it("keeps the current ProductBlock type names readable without requiring frontend migration", () => {
    const blocks: ProductBlock[] = [
      { type: "experience_list", data: {} },
      { type: "experience_card", data: {} },
      { type: "experience_detail", data: {} },
      { type: "experience_candidate_form", data: {} },
      { type: "jd_analysis_result", data: {} },
      { type: "action_result", data: {} },
      { type: "experience_match_results", data: {} },
      { type: "jd_match_results", data: {} },
    ];

    expect(blocks.map((block) => block.type)).toEqual([
      "experience_list",
      "experience_card",
      "experience_detail",
      "experience_candidate_form",
      "jd_analysis_result",
      "action_result",
      "experience_match_results",
      "jd_match_results",
    ]);
    for (const block of blocks) {
      expect(block).toMatchObject({ type: expect.any(String), data: expect.any(Object) });
    }
  });
});

function assertCopilotResponseContract(response: CopilotChatResponse): void {
  expect(response).toMatchObject({
    sessionId: expect.any(String),
    turnId: expect.any(String),
    assistantMessage: {
      id: expect.any(String),
      sessionId: expect.any(String),
      role: "assistant",
      content: expect.any(String),
      kind: expect.any(String),
      createdAt: expect.any(String),
    },
    timeline: expect.any(Array),
    workspace: {
      id: expect.any(String),
      sessionId: expect.any(String),
      variants: expect.any(Array),
      status: expect.any(String),
      updatedAt: expect.any(String),
    },
    nextActions: expect.any(Array),
    raw: {
      artifactIds: expect.any(Array),
      evidenceChainIds: expect.any(Array),
      critiqueItemIds: expect.any(Array),
      decisionIds: expect.any(Array),
    },
  });
}

function assertToolDefinitionContract(tool: ToolDefinition): void {
  expect(tool).toMatchObject({
    name: expect.any(String),
    description: expect.any(String),
    ownerAgent: expect.any(String),
    inputSchema: expect.any(z.ZodType),
    outputSchema: expect.any(z.ZodType),
    mutability: expect.any(String),
    requiresConfirmation: expect.any(Boolean),
    riskLevel: expect.any(String),
    execute: expect.any(Function),
  });
  expect(["frontdesk", "experience_receiver", "strategist", "architect", "critic"]).toContain(tool.ownerAgent as AgentName);
  expect(["read", "write", "delete", "export"]).toContain(tool.mutability);
  expect(["low", "medium", "high"]).toContain(tool.riskLevel);
}
