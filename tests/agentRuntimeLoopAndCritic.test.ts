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

  it("records revision_request and lets the source agent see critic feedback", async () => {
    const { kernel, orchestrator } = await setupRuntime("critic-revision");
    registerUnconfirmedGenerateTool(orchestrator);
    const ctx = createTestKernelContext({ user: { id: "revision-user" }, request: { requestId: "req-revision", traceId: "trace-revision" } });

    const response = await orchestrator.handleChat(ctx, { message: "resume critic revision" });
    const metadata = response.raw.metadata as RuntimeMetadata;

    expect(response.assistantMessage.content).toContain("revised after critic");
    expect(metadata.criticReview?.verdict).toBe("needs_revision");
    expect(metadata.agentMessages.some((message) => message.type === "review_request")).toBe(true);
    expect(metadata.agentMessages.some((message) => message.type === "revision_request")).toBe(true);
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
});

async function setupRuntime(scenario: Scenario): Promise<{ kernel: ApiKernel; orchestrator: AgentOrchestrator }> {
  const kernel = await createP12Kernel();
  kernel.frontDeskModelClient = new ModelClient({
    provider: new RuntimeTestProvider(scenario),
    defaultModel: "runtime-test",
  });
  return { kernel, orchestrator: new AgentOrchestrator({ kernel }) };
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

type Scenario = "loop-final" | "max-steps" | "critic-pass" | "critic-revision" | "critic-blocked";

class RuntimeTestProvider implements LLMProvider {
  public readonly name = "runtime-test";

  public constructor(private readonly scenario: Scenario) {}

  public async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    const payload = readPayload(request);
    const agentName = request.metadata?.agentName;
    if (agentName === "agent-core:frontdesk") return json(route("architect"));
    if (agentName === "agent-core:architect") return json(this.architect(payload));
    if (agentName === "agent-core:critic") return json(this.critic(payload));
    return json(final("strategist", "Done."));
  }

  private architect(payload: Record<string, unknown>): Record<string, unknown> {
    const observations = Array.isArray(payload.observations) ? payload.observations : [];
    const messages = Array.isArray(payload.agentMessages) ? payload.agentMessages as Array<{ type?: string }> : [];
    if (this.scenario === "loop-final") {
      return observations.length > 0 ? final("architect", "saw observation and finished") : plan("architect", "list_resumes", {}, "List resumes first.");
    }
    if (this.scenario === "max-steps") return plan("architect", "list_resumes", {}, "Keep planning until capped.");
    if (this.scenario === "critic-revision" && messages.some((message) => message.type === "revision_request")) {
      return final("architect", "revised after critic feedback");
    }
    if (observations.some((item) => isObservationFor(item, "generate_resume_from_jd"))) {
      return final("architect", "generated passed critic review");
    }
    return plan("architect", "generate_resume_from_jd", { jdText: "JD", targetRole: "Engineer" }, "Generate resume.");
  }

  private critic(_payload: Record<string, unknown>): Record<string, unknown> {
    if (this.scenario === "critic-revision") return review("needs_revision", "medium", "Please make this more conservative.");
    if (this.scenario === "critic-blocked") return review("blocked", "high", "Cannot use this generated content because it includes unsupported claims.");
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
