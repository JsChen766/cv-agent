import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ModelClient } from "../src/agent-core/model/ModelClient.js";
import type { LLMChatRequest, LLMChatResponse, LLMProvider } from "../src/agent-core/model/types.js";
import { AgentOrchestrator } from "../src/agent-core/runtime/AgentOrchestrator.js";
import { ToolResultSchema } from "../src/agent-core/validation/ToolInputSchemas.js";
import { createTestKernelContext } from "../src/api/context.js";
import type { ApiKernel } from "../src/api/types.js";
import { createP12Kernel } from "./p12Helpers.js";

describe("agent runtime loop and critic gate", () => {
  it("lets a specialist see tool observations and decide again", async () => {
    const { kernel, orchestrator } = await setupRuntime("loop-final");
    const ctx = createTestKernelContext({ user: { id: "loop-user" }, request: { requestId: "req-loop", traceId: "trace-loop" } });

    const response = await orchestrator.handleChat(ctx, { message: "resume loop final" });
    const metadata = response.raw.metadata as RuntimeMetadata;

    expect(response.assistantMessage.content).toContain("saw observation");
    expect(metadata.loop.stopReason).toBe("final");
    expect(metadata.observations.length).toBeGreaterThan(0);
    await kernel.close();
  });

  it("stops gracefully at maxSteps without throwing", async () => {
    const previous = process.env.AGENT_LOOP_MAX_STEPS;
    process.env.AGENT_LOOP_MAX_STEPS = "1";
    const { kernel, orchestrator } = await setupRuntime("max-steps");
    const ctx = createTestKernelContext({ user: { id: "max-user" }, request: { requestId: "req-max", traceId: "trace-max" } });

    const response = await orchestrator.handleChat(ctx, { message: "resume max steps" });
    const metadata = response.raw.metadata as RuntimeMetadata;

    expect(response.assistantMessage.content).toContain("completed the available runtime steps");
    expect(metadata.loop.stepCount).toBe(1);
    expect(metadata.loop.stopReason).toBe("max_steps");
    if (previous === undefined) delete process.env.AGENT_LOOP_MAX_STEPS;
    else process.env.AGENT_LOOP_MAX_STEPS = previous;
    await kernel.close();
  });

  it("continues normally when critic passes a generated result", async () => {
    const { kernel, orchestrator } = await setupRuntime("critic-pass");
    registerUnconfirmedGenerateTool(orchestrator);
    const ctx = createTestKernelContext({ user: { id: "pass-user" }, request: { requestId: "req-pass", traceId: "trace-pass" } });

    const response = await orchestrator.handleChat(ctx, { message: "resume critic pass" });
    const metadata = response.raw.metadata as RuntimeMetadata;

    expect(response.assistantMessage.content).toContain("generated passed");
    expect(metadata.criticReview?.verdict).toBe("pass");
    expect(metadata.agentMessages.some((message) => message.type === "review_request")).toBe(true);
    await kernel.close();
  });

  it("auto-loops after critic needs_revision and finishes when specialist revises", async () => {
    const { kernel, orchestrator } = await setupRuntime("critic-revision");
    registerUnconfirmedGenerateTool(orchestrator);
    const ctx = createTestKernelContext({ user: { id: "revision-user" }, request: { requestId: "req-revision", traceId: "trace-revision" } });

    const response = await orchestrator.handleChat(ctx, { message: "resume critic revision" });
    const metadata = response.raw.metadata as RuntimeMetadata;

    // After the first needs_revision the orchestrator must NOT terminate the
    // response with critic_needs_revision. Instead it records the revision
    // request, re-runs the specialist, and the architect's second decide()
    // sees the revision_request in agentMessages and produces a final reply.
    expect(metadata.loop.stopReason).toBe("final");
    expect(metadata.criticReview?.verdict).toBe("needs_revision");
    expect(metadata.agentMessages.some((message) => message.type === "review_request")).toBe(true);
    expect(metadata.agentMessages.some((message) => message.type === "revision_request")).toBe(true);
    // No critic_needs_revision needs_input is surfaced to the user on the first
    // automatic retry — that only happens after MAX_REVISION_ATTEMPTS (=3).
    expect(response.raw.actionResults?.some((item) => item.reason === "critic_needs_revision")).toBe(false);
    // Workspace must not be flipped into the user-facing "revision_needed" state
    // when the agent auto-recovered within the retry budget.
    expect(response.workspace.status).not.toBe("revision_needed");
    await kernel.close();
  });

  it("returns the generated result when critic eventually passes within 3 attempts", async () => {
    const { kernel, orchestrator, provider } = await setupRuntime("critic-revision-then-pass");
    registerUnconfirmedGenerateTool(orchestrator);
    const ctx = createTestKernelContext({ user: { id: "revision-then-pass" }, request: { requestId: "req-rtp", traceId: "trace-rtp" } });

    const response = await orchestrator.handleChat(ctx, { message: "resume critic revision then pass" });
    const metadata = response.raw.metadata as RuntimeMetadata;

    // Critic was called once per specialist iteration: 2 needs_revision +
    // 1 pass = 3 total calls. Stop reason must be the final, not the retry cap.
    expect(provider.criticCalls).toBe(3);
    expect(metadata.loop.stopReason).toBe("final");
    expect(metadata.criticReview?.verdict).toBe("pass");
    expect(response.raw.actionResults?.some((item) => item.reason === "critic_needs_revision")).toBe(false);
    // Each automatic retry recorded a revision_request and an announcement.
    const revisionRequests = metadata.agentMessages.filter((message) => message.type === "revision_request");
    expect(revisionRequests.length).toBe(2);
    await kernel.close();
  });

  it("uses the first generate confirmation to authorize critic revisions without new pending actions", async () => {
    const { kernel, orchestrator, provider } = await setupRuntime("confirm-revision-then-pass");
    const ctx = createTestKernelContext({ user: { id: "confirm-revision-then-pass-user" }, request: { requestId: "req-crtp", traceId: "trace-crtp" } });

    const pending = await orchestrator.handleChat(ctx, { message: "resume confirm revision then pass" });
    const initialPendingActions = pending.raw.pendingActions ?? [];
    expect(initialPendingActions).toHaveLength(1);
    expect(initialPendingActions[0]).toMatchObject({ toolName: "generate_resume_from_jd" });
    expect(provider.criticCalls).toBe(0);

    const pendingId = (initialPendingActions[0] as { id: string }).id;
    const queued = await orchestrator.confirmPendingAction(ctx, pendingId);
    const jobId = queued.raw.actionResults
      ?.find((item) => item.actionType === "generate_resume_from_jd")
      ?.metadata?.jobId;
    expect(typeof jobId).toBe("string");
    expect(queued.raw.pendingActions ?? []).toHaveLength(0);
    expect(provider.criticCalls).toBe(0);

    await kernel.jobRunner.runJob(String(jobId), ctx.user.id);
    const response = await orchestrator.confirmPendingAction(ctx, pendingId);
    const metadata = response.raw.metadata as RuntimeMetadata;

    expect(provider.criticCalls).toBe(3);
    expect(metadata.loop.stopReason).toBe("final");
    expect(metadata.criticReview?.verdict).toBe("pass");
    expect(response.raw.pendingActions ?? []).toHaveLength(0);
    expect(response.raw.actionResults?.some((item) => item.status === "needs_confirmation")).not.toBe(true);
    expect(response.workspace.status).toBe("ready");
    expect((response.workspace.variants ?? []).length).toBeGreaterThan(0);
    expect((response.workspace as unknown as { activePanel?: string }).activePanel).toBe("variants");
    const revisionRequests = metadata.agentMessages.filter((message) => message.type === "revision_request");
    expect(revisionRequests.length).toBe(2);
    await kernel.close();
  });

  it("stops with critic_needs_revision after 3 consecutive needs_revision verdicts", async () => {
    const { kernel, orchestrator, provider } = await setupRuntime("critic-revision-exhausted");
    registerUnconfirmedGenerateTool(orchestrator);
    const ctx = createTestKernelContext({ user: { id: "exhausted-user" }, request: { requestId: "req-exh", traceId: "trace-exh" } });

    const response = await orchestrator.handleChat(ctx, { message: "resume critic exhausted" });
    const metadata = response.raw.metadata as RuntimeMetadata;

    expect(provider.criticCalls).toBe(3);
    expect(metadata.loop.stopReason).toBe("critic_needs_revision");
    expect(metadata.criticReview?.verdict).toBe("needs_revision");
    const criticAction = response.raw.actionResults?.find((item) => item.reason === "critic_needs_revision");
    expect(criticAction?.actionType).toBe("critic_gate");
    expect((criticAction?.metadata as Record<string, unknown> | undefined)?.attempts).toBe(3);
    expect((criticAction?.metadata as Record<string, unknown> | undefined)?.maxAttempts).toBe(3);
    expect(Array.isArray((criticAction?.metadata as Record<string, unknown> | undefined)?.suggestedFixes)).toBe(true);
    // Suggested fixes are exposed to the user only on the final stop, not on
    // earlier auto-retries.
    expect(response.assistantMessage.content).toContain("Use conservative wording.");
    expect(response.workspace.status).toBe("revision_needed");
    // Revision_request was recorded for each of the 3 needs_revision verdicts.
    const revisionRequests = metadata.agentMessages.filter((message) => message.type === "revision_request");
    expect(revisionRequests.length).toBe(3);
    await kernel.close();
  });

  it("blocks high-risk generated content when critic blocks", async () => {
    const { kernel, orchestrator } = await setupRuntime("critic-blocked");
    registerUnconfirmedGenerateTool(orchestrator);
    const ctx = createTestKernelContext({ user: { id: "blocked-user" }, request: { requestId: "req-blocked", traceId: "trace-blocked" } });

    const response = await orchestrator.handleChat(ctx, { message: "resume critic blocked" });
    const metadata = response.raw.metadata as RuntimeMetadata;

    expect(response.assistantMessage.content).toContain("Cannot use this generated content");
    expect(response.assistantMessage.content).not.toContain("Generated risky resume content");
    expect(metadata.loop.stopReason).toBe("critic_blocked");
    expect(metadata.criticReview?.verdict).toBe("blocked");
    expect(JSON.stringify(response.raw.toolResults)).not.toContain("Generated risky resume content");
    await kernel.close();
  });

  it("requires user confirmation when critic review parsing fails", async () => {
    const { kernel, orchestrator } = await setupRuntime("critic-parse-failed");
    registerUnconfirmedGenerateTool(orchestrator);
    const ctx = createTestKernelContext({ user: { id: "parse-user" }, request: { requestId: "req-parse", traceId: "trace-parse" } });

    const response = await orchestrator.handleChat(ctx, { message: "resume critic parse failed" });
    const metadata = response.raw.metadata as RuntimeMetadata;

    expect(response.assistantMessage.content).toContain("could not reliably parse the critic review");
    expect(metadata.criticReview?.verdict).toBe("needs_user_confirmation");
    expect(response.raw.actionResults?.[0]?.status).toBe("needs_input");
    expect(response.raw.actionResults?.some((item) => item.status === "needs_confirmation")).not.toBe(true);
    await kernel.close();
  });

  it("does not re-review confirmed generate_resume_from_jd after the pending action executes", async () => {
    const { kernel, orchestrator, provider } = await setupRuntime("confirm-pass");
    registerConfirmedGenerateTool(orchestrator);
    const ctx = createTestKernelContext({ user: { id: "confirm-pass-user" }, request: { requestId: "req-confirm-pass", traceId: "trace-confirm-pass" } });

    const pending = await orchestrator.handleChat(ctx, { message: "resume confirm pass" });
    const pendingId = (pending.raw.pendingActions![0] as { id: string }).id;
    expect(provider.criticCalls).toBe(0);

    const response = await orchestrator.confirmPendingAction(ctx, pendingId);
    const metadata = response.raw.metadata as RuntimeMetadata;

    expect(provider.criticCalls).toBe(0);
    expect(response.assistantMessage.content).toContain("Resume generation has started");
    expect((response.workspace as unknown as { activePanel?: string }).activePanel).toBe("variants");
    expect(metadata.criticReview).toBeUndefined();
    expect(response.raw.actionResults?.[0]?.status).toBe("success");
    await kernel.close();
  });

  it("keeps confirmed generate_resume_from_jd result even when critic fixture would block a new run", async () => {
    const { kernel, orchestrator } = await setupRuntime("confirm-blocked");
    registerConfirmedGenerateTool(orchestrator);
    const ctx = createTestKernelContext({ user: { id: "confirm-blocked-user" }, request: { requestId: "req-confirm-blocked", traceId: "trace-confirm-blocked" } });

    const pending = await orchestrator.handleChat(ctx, { message: "resume confirm blocked" });
    const pendingId = (pending.raw.pendingActions![0] as { id: string }).id;

    const response = await orchestrator.confirmPendingAction(ctx, pendingId);
    const metadata = response.raw.metadata as RuntimeMetadata;

    expect(response.assistantMessage.content).toContain("Resume generation has started");
    // Workspace patch is preserved even when critic blocks — the user needs to see what was generated
    expect((response.workspace as unknown as { activePanel?: string }).activePanel).toBe("variants");
    expect(metadata.criticReview).toBeUndefined();
    expect(JSON.stringify(response.raw.toolResults)).toContain("jobId");
    await kernel.close();
  });

  it("keeps confirmed generate_resume_from_jd result even when critic fixture would request revision", async () => {
    const { kernel, orchestrator } = await setupRuntime("confirm-revision");
    registerConfirmedGenerateTool(orchestrator);
    const ctx = createTestKernelContext({ user: { id: "confirm-revision-user" }, request: { requestId: "req-confirm-revision", traceId: "trace-confirm-revision" } });

    const pending = await orchestrator.handleChat(ctx, { message: "resume confirm revision" });
    const pendingId = (pending.raw.pendingActions![0] as { id: string }).id;

    const response = await orchestrator.confirmPendingAction(ctx, pendingId);
    const metadata = response.raw.metadata as RuntimeMetadata;

    expect(response.assistantMessage.content).toContain("Resume generation has started");
    expect(metadata.loop.stopReason).not.toBe("critic_needs_revision");
    expect(metadata.criticReview).toBeUndefined();
    expect(metadata.agentMessages.some((message) => message.type === "revision_request")).toBe(false);
    expect(JSON.stringify(response.raw.toolResults)).toContain("jobId");
    await kernel.close();
  });

  it("does not review a confirmed low-risk pending action", async () => {
    const { kernel, orchestrator, provider } = await setupRuntime("confirm-low-risk");
    registerConfirmedExportTool(orchestrator);
    const ctx = createTestKernelContext({ user: { id: "confirm-low-risk-user" }, request: { requestId: "req-confirm-low-risk", traceId: "trace-confirm-low-risk" } });
    const resume = await kernel.productServices.resumeService.createResume("confirm-low-risk-user", { title: "Scoped resume" });

    const pending = await orchestrator.handleChat(ctx, { message: "resume confirm low risk", clientState: { activeResumeId: resume.id } });
    const pendingId = (pending.raw.pendingActions![0] as { id: string }).id;

    const response = await orchestrator.confirmPendingAction(ctx, pendingId);

    expect(provider.criticCalls).toBe(0);
    expect(response.assistantMessage.content).toContain("Exported resume.");
    expect((response.workspace as unknown as { exportReady?: boolean }).exportReady).toBe(true);
    await kernel.close();
  });

  it("downgrades needs_confirmation action results without pendingActionId from read tools", async () => {
    const { kernel, orchestrator } = await setupRuntime("invalid-confirmation");
    registerInvalidConfirmationTool(orchestrator);
    const ctx = createTestKernelContext({ user: { id: "invalid-confirm-user" }, request: { requestId: "req-invalid-confirm", traceId: "trace-invalid-confirm" } });
    const resume = await kernel.productServices.resumeService.createResume("invalid-confirm-user", { title: "Scoped resume" });

    const response = await orchestrator.handleChat(ctx, { message: "resume invalid confirmation", clientState: { activeResumeId: resume.id } });

    // The safety net downgrades needs_confirmation from read tools to success
    // so the user does NOT see the invalidConfirmation error
    expect(response.assistantMessage.content).not.toContain("confirmation action is missing a confirmation ID");
    expect(response.raw.pendingActions).toHaveLength(0);
    expect(response.raw.actionResults?.some((item) => item.status === "needs_confirmation")).not.toBe(true);
    expect(response.raw.actionResults?.[0]).toMatchObject({
      status: "success",
      reason: "read_tool_cannot_request_confirmation",
    });
    expect(JSON.stringify(response.raw.agentTrace)).toContain("Downgraded unexpected needs_confirmation");
    await kernel.close();
  });
});

async function setupRuntime(scenario: Scenario): Promise<{ kernel: ApiKernel; orchestrator: AgentOrchestrator; provider: RuntimeTestProvider }> {
  const kernel = await createP12Kernel();
  const provider = new RuntimeTestProvider(scenario);
  kernel.frontDeskModelClient = new ModelClient({
    provider,
    defaultModel: "runtime-test",
  });
  return { kernel, orchestrator: new AgentOrchestrator({ kernel, pendingActions: kernel.pendingActions }), provider };
}

function registerUnconfirmedGenerateTool(orchestrator: AgentOrchestrator): void {
  orchestrator.tools.register({
    name: "generate_resume_from_jd",
    description: "Test resume generation without confirmation.",
    ownerAgent: "architect",
    inputSchema: z.object({ jdText: z.string().optional(), targetRole: z.string().optional() }).passthrough(),
    outputSchema: ToolResultSchema,
    mutability: "write",
    requiresConfirmation: false,
    riskLevel: "medium",
    execute: async () => ({
      status: "success",
      message: "Generated risky resume content.",
      data: { content: "Generated risky resume content" },
      workspacePatch: { activePanel: "variants" },
    }),
  });
}

function registerConfirmedGenerateTool(orchestrator: AgentOrchestrator): void {
  orchestrator.tools.register({
    name: "generate_resume_from_jd",
    description: "Test confirmed resume generation.",
    ownerAgent: "architect",
    inputSchema: z.object({ jdText: z.string().optional(), targetRole: z.string().optional() }).passthrough(),
    outputSchema: ToolResultSchema,
    mutability: "write",
    requiresConfirmation: true,
    riskLevel: "high",
    execute: async () => ({
      status: "success",
      message: "Confirmed generated resume content.",
      data: { content: "Confirmed generated resume content." },
      workspacePatch: { activePanel: "variants" },
      actionResult: { actionType: "generate_resume_from_jd", status: "success", message: "Confirmed generated resume content." },
    }),
  });
}

function registerConfirmedExportTool(orchestrator: AgentOrchestrator): void {
  orchestrator.tools.register({
    name: "export_resume",
    description: "Test confirmed export.",
    ownerAgent: "architect",
    inputSchema: z.object({ resumeId: z.string().optional(), format: z.string().optional() }).passthrough(),
    outputSchema: ToolResultSchema,
    mutability: "export",
    requiresConfirmation: true,
    riskLevel: "medium",
    execute: async () => ({
      status: "success",
      message: "Exported resume.",
      workspacePatch: { exportReady: true },
      actionResult: { actionType: "export_resume", status: "success", message: "Exported resume." },
    }),
  });
}

function registerInvalidConfirmationTool(orchestrator: AgentOrchestrator): void {
  orchestrator.tools.register({
    name: "prepare_export_resume",
    description: "Invalid confirmation result for runtime defense.",
    ownerAgent: "architect",
    inputSchema: z.object({ resumeId: z.string(), format: z.string() }).passthrough(),
    outputSchema: ToolResultSchema,
    mutability: "read",
    requiresConfirmation: false,
    riskLevel: "low",
    execute: async () => ({
      status: "success",
      message: "Bad confirmation result.",
      actionResult: { actionType: "export_resume", status: "needs_confirmation" },
    }),
  });
}

type Scenario =
  | "loop-final"
  | "max-steps"
  | "critic-pass"
  | "critic-revision"
  | "critic-revision-then-pass"
  | "critic-revision-exhausted"
  | "confirm-revision-then-pass"
  | "critic-blocked"
  | "critic-parse-failed"
  | "confirm-pass"
  | "confirm-blocked"
  | "confirm-revision"
  | "confirm-low-risk"
  | "invalid-confirmation";

class RuntimeTestProvider implements LLMProvider {
  public readonly name = "runtime-test";
  public criticCalls = 0;

  public constructor(private readonly scenario: Scenario) {}

  public async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    const payload = readPayload(request);
    const agentName = request.metadata?.agentName;
    if (agentName === "agent-core:frontdesk") return json(route("architect"));
    if (agentName === "agent-core:architect") return json(this.architect(payload));
    if (agentName === "agent-core:critic") {
      this.criticCalls += 1;
      return json(this.critic(payload));
    }
    return json(final("strategist", "Done."));
  }

  private architect(payload: Record<string, unknown>): Record<string, unknown> {
    const observations = Array.isArray(payload.observations) ? payload.observations : [];
    const messages = Array.isArray(payload.agentMessages) ? payload.agentMessages as Array<{ type?: string }> : [];
    const clientState = typeof payload.clientState === "object" && payload.clientState !== null ? payload.clientState as Record<string, unknown> : {};
    const resumeId = typeof clientState.activeResumeId === "string" ? clientState.activeResumeId : "resume-1";
    if (this.scenario === "confirm-low-risk") {
      return plan("architect", "export_resume", { resumeId, format: "html" }, "Export resume.");
    }
    if (this.scenario === "invalid-confirmation") {
      return plan("architect", "prepare_export_resume", { resumeId, format: "html" }, "Prepare invalid confirmation.");
    }
    if (this.scenario === "confirm-revision-then-pass") {
      const generateObsCount = observations.filter((item) => isObservationFor(item, "generate_resume_from_jd")).length;
      if (generateObsCount >= 3) return final("architect", "confirmed generated passed after revisions");
      return plan("architect", "generate_resume_from_jd", { jdText: "JD", targetRole: "Engineer" }, "Generate resume.");
    }
    if (this.scenario.startsWith("confirm-")) {
      return plan("architect", "generate_resume_from_jd", { jdText: "JD", targetRole: "Engineer" }, "Generate resume.");
    }
    if (this.scenario === "loop-final") {
      return observations.length > 0 ? final("architect", "saw observation and finished") : plan("architect", "list_resumes", {}, "List resumes first.");
    }
    if (this.scenario === "max-steps") return plan("architect", "list_resumes", {}, "Keep planning until capped.");
    if (this.scenario === "critic-revision" && messages.some((message) => message.type === "revision_request")) {
      return final("architect", "revised after critic feedback");
    }
    // critic-revision-then-pass / critic-revision-exhausted: each iteration
    // re-plans generate_resume_from_jd so the critic can keep reviewing the
    // (mock) regenerated output until it passes or the retry cap is reached.
    if (this.scenario === "critic-revision-then-pass") {
      // After 3 generate observations (1 initial + 2 revisions), the critic
      // has passed on the most recent run — finalise so the loop terminates.
      const generateObsCount = observations.filter((item) => isObservationFor(item, "generate_resume_from_jd")).length;
      if (generateObsCount >= 3) return final("architect", "generated passed after revisions");
      return plan("architect", "generate_resume_from_jd", { jdText: "JD", targetRole: "Engineer" }, "Generate resume.");
    }
    if (this.scenario === "critic-revision-exhausted") {
      return plan("architect", "generate_resume_from_jd", { jdText: "JD", targetRole: "Engineer" }, "Generate resume.");
    }
    if (observations.some((item) => isObservationFor(item, "generate_resume_from_jd"))) {
      return final("architect", "generated passed critic review");
    }
    return plan("architect", "generate_resume_from_jd", { jdText: "JD", targetRole: "Engineer" }, "Generate resume.");
  }

  private critic(_payload: Record<string, unknown>): Record<string, unknown> {
    if (this.scenario === "critic-revision-then-pass" || this.scenario === "confirm-revision-then-pass") {
      // criticCalls was already incremented for this call.
      return this.criticCalls >= 3
        ? review("pass", "low", "Critic pass after revisions.")
        : review("needs_revision", "medium", "Please make this more conservative.");
    }
    if (this.scenario === "critic-revision-exhausted") {
      return review("needs_revision", "medium", "Please make this more conservative.");
    }
    if (this.scenario === "critic-revision" || this.scenario === "confirm-revision") return review("needs_revision", "medium", "Please make this more conservative.");
    if (this.scenario === "critic-blocked" || this.scenario === "confirm-blocked") return review("blocked", "high", "Cannot use this generated content because it includes unsupported claims.");
    if (this.scenario === "critic-parse-failed") return final("critic", "Unstructured critic response.");
    return review("pass", "low", "Critic pass.");
  }
}

function route(routeTo: string): Record<string, unknown> {
  return { agentName: "frontdesk", responseType: "route", routeTo, assistantMessage: "", plan: [], missingInputs: [], confidence: 0.9 };
}

function final(agentName: string, assistantMessage: string): Record<string, unknown> {
  return { agentName, responseType: "final", assistantMessage, plan: [], missingInputs: [], confidence: 0.9 };
}

function plan(agentName: string, toolName: string, args: Record<string, unknown>, summary: string): Record<string, unknown> {
  return {
    agentName,
    responseType: "plan",
    assistantMessage: "",
    plan: [{ id: `step-${toolName}`, agentName, toolName, arguments: args, summary }],
    missingInputs: [],
    confidence: 0.9,
  };
}

function review(verdict: string, riskLevel: string, summary: string): Record<string, unknown> {
  return {
    agentName: "critic",
    responseType: "final",
    assistantMessage: summary,
    plan: [],
    missingInputs: [],
    confidence: 0.9,
    criticReview: {
      verdict,
      riskLevel,
      unsupportedClaims: verdict === "pass" ? [] : ["unsupported impact claim"],
      missingEvidence: verdict === "pass" ? [] : ["source metric"],
      suggestedFixes: verdict === "needs_revision" ? ["Use conservative wording."] : [],
      userVisibleSummary: summary,
    },
  };
}

function readPayload(request: LLMChatRequest): Record<string, unknown> {
  const text = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "{}";
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function json(value: Record<string, unknown>): LLMChatResponse {
  return { content: JSON.stringify(value) };
}

function isObservationFor(value: unknown, toolName: string): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (value as { toolName?: unknown }).toolName === toolName;
}

type RuntimeMetadata = {
  loop: { stepCount: number; maxSteps: number; stopReason?: string };
  observations: unknown[];
  agentMessages: Array<{ type: string }>;
  criticReview?: { verdict: string };
};
