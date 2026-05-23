import { describe, expect, it } from "vitest";
import { ModelClient } from "../src/agent-core/model/ModelClient.js";
import type { LLMChatRequest, LLMChatResponse, LLMProvider } from "../src/agent-core/model/types.js";
import { AgentOrchestrator } from "../src/agent-core/runtime/AgentOrchestrator.js";
import { FrontDeskHandoffSchema } from "../src/copilot/handoff/FrontDeskHandoffSchema.js";
import { normalizeFrontDeskHandoff } from "../src/copilot/handoff/HandoffNormalizer.js";
import { applyHandoffToDrafts } from "../src/copilot/context/DraftContext.js";
import { ContextHydrator } from "../src/copilot/context/ContextHydrator.js";
import { ResponseComposer } from "../src/copilot/response/ResponseComposer.js";
import type { CopilotWorkspace } from "../src/copilot/types.js";
import { createTestKernelContext } from "../src/api/context.js";
import { createP12Kernel } from "./p12Helpers.js";

const JD_TEXT = `Senior Frontend Engineer
Company: Example Tech
Responsibilities:
- Build React and TypeScript product workflows.
- Collaborate with design, data, and backend teams.
Requirements:
- 5+ years frontend engineering experience.
- Strong ownership of complex user-facing systems.`;

describe("FrontDeskHandoff and DraftContext", () => {
  it("normalizes ordinary chat, JD text, and experience rewrite intents", () => {
    const chat = normalizeFrontDeskHandoff({
      raw: undefined,
      sessionId: "cs-1",
      turnId: "ct-1",
      userMessage: "你好",
    }).handoff;
    expect(chat.intent).toBe("general.chat");

    const jd = normalizeFrontDeskHandoff({
      raw: undefined,
      sessionId: "cs-1",
      turnId: "ct-2",
      userMessage: JD_TEXT,
    }).handoff;
    expect(["jd.intake", "resume.generate_from_jd"]).toContain(jd.intent);
    expect(jd.extracted.jdText).toContain("Senior Frontend Engineer");

    const rewrite = normalizeFrontDeskHandoff({
      raw: undefined,
      sessionId: "cs-1",
      turnId: "ct-3",
      userMessage: "优化这条经历",
    }).handoff;
    expect(rewrite.intent).toBe("experience.rewrite");
  });

  it("schema accepts a complete FrontDeskHandoff and drafts stay bounded", () => {
    const now = new Date().toISOString();
    const parsed = FrontDeskHandoffSchema.safeParse({
      id: "handoff-1",
      sessionId: "cs-1",
      turnId: "ct-1",
      intent: "jd.intake",
      confidence: 0.9,
      routeTo: "strategist",
      extracted: { jdText: JD_TEXT },
      suggestedActions: ["save_jd", "analyze_jd", "generate_resume"],
      next: "handoff",
      createdAt: now,
    });
    expect(parsed.success).toBe(true);

    let workspace: CopilotWorkspace | null = {
      id: "ws-1",
      sessionId: "cs-1",
      variants: [],
      status: "empty",
      updatedAt: now,
    };
    for (let i = 0; i < 7; i += 1) {
      const handoff = normalizeFrontDeskHandoff({
        raw: { intent: "jd.intake", routeTo: "strategist", extracted: { jdText: `${JD_TEXT}\n${i}` }, next: "handoff" },
        sessionId: "cs-1",
        turnId: `ct-${i}`,
        userMessage: `${JD_TEXT}\n${i}`,
      }).handoff;
      workspace = { ...workspace, ...applyHandoffToDrafts(workspace, handoff, now) };
    }
    expect(workspace.drafts?.jdDrafts.length).toBeLessThanOrEqual(5);
  });
});

describe("ContextHydrator and ResponseComposer", () => {
  it("hydrates active experience and JD draft inputs", () => {
    const hydrator = new ContextHydrator();
    const workspace: CopilotWorkspace = {
      id: "ws-1",
      sessionId: "cs-1",
      variants: [],
      status: "empty",
      updatedAt: new Date().toISOString(),
      active: { jdDraftId: "jddraft-1" },
      drafts: {
        jdDrafts: [{
          id: "jddraft-1",
          kind: "jd",
          rawText: JD_TEXT,
          source: "handoff",
          status: "draft",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastReferencedAt: new Date().toISOString(),
        }],
        experienceDrafts: [],
        resumeDrafts: [],
      },
    };
    const context = {
      clientState: { activeExperienceId: "exp-1", selectedText: "make it stronger" },
      activeAssetContext: undefined,
      productContext: {},
      userMessage: "那就生成吧",
    } as any;
    expect(hydrator.hydrate("get_experience", {}, context, workspace).id).toBe("exp-1");
    expect(hydrator.hydrate("update_experience", { instruction: "rewrite" }, context, workspace).experienceId).toBe("exp-1");
    expect(hydrator.hydrate("generate_resume_from_jd", {}, context, workspace).jdText).toContain("Senior Frontend Engineer");
    expect(hydrator.hydrate("revise_resume_item", { resumeItemId: "item-1" }, context, workspace).instruction).toBe("make it stronger");
  });

  it("hydrates accept_generation_variant from workspace.productGenerationId and activeVariantId", () => {
    const hydrator = new ContextHydrator();
    const workspace: CopilotWorkspace = {
      id: "ws-accept",
      sessionId: "cs-1",
      variants: [],
      status: "empty",
      updatedAt: new Date().toISOString(),
      productGenerationId: "pgen-1",
      activeVariantId: "variant-2",
      active: { variantId: "variant-3" },
    };
    const context = {
      clientState: {},
      activeAssetContext: undefined,
      productContext: {},
      userMessage: "接受这个版本",
    } as any;

    const hydrated = hydrator.hydrate("accept_generation_variant", {}, context, workspace);
    expect(hydrated.generationId).toBe("pgen-1");
    // active.variantId takes precedence over activeVariantId per the fallback chain
    expect(hydrated.variantId).toBe("variant-3");
  });

  it("does not leak internal tool logs into assistant text", () => {
    const composer = new ResponseComposer();
    const output = composer.compose({
      locale: "zh-CN",
      userMessage: "看一下经历库",
      workspace: null,
      toolResults: [
        { status: "success", message: "Your experience library has 1 item(s).", visibility: "internal" },
        { status: "success", message: "No obvious unsupported claims found.", visibility: "internal" },
      ],
      pendingActions: [],
      context: { productContext: {} } as any,
    });
    expect(output.assistantText).not.toContain("Your experience library");
    expect(output.assistantText).not.toContain("No obvious unsupported claims found");
  });
});

describe("/copilot chat kernel refactor flows", () => {
  it("creates a JD draft from pasted JD and uses it on the next generation turn", async () => {
    const kernel = await createP12Kernel();
    kernel.frontDeskModelClient = new ModelClient({ provider: new KernelRefactorProvider(), defaultModel: "kernel-refactor-test" });
    const orchestrator = new AgentOrchestrator({ kernel });
    const ctx = createTestKernelContext({ user: { id: "user-1" }, request: { requestId: "req-1", traceId: "trace-1" } });

    const intake = await orchestrator.handleChat(ctx, { message: JD_TEXT });
    expect(intake.assistantMessage.content).toContain("JD");
    expect(intake.assistantMessage.content).not.toContain("请先选择或保存一份 JD");
    expect(intake.assistantMessage.content).not.toContain("Your experience library");
    expect(intake.workspace.drafts?.jdDrafts.length).toBeGreaterThan(0);

    const generated = await orchestrator.handleChat(ctx, { sessionId: intake.sessionId, message: "那就生成吧" });
    expect(generated.raw.pendingActions?.[0]).toMatchObject({ toolName: "generate_resume_from_jd" });
    expect(generated.assistantMessage.content).not.toContain("请先选择或保存一份 JD");
    expect(generated.raw.actionResults?.[0]?.status).toBe("needs_confirmation");
    await kernel.close();
  });

  it("hydrates current experience rewrite from activeExperienceId", async () => {
    const kernel = await createP12Kernel();
    kernel.frontDeskModelClient = new ModelClient({ provider: new KernelRefactorProvider(), defaultModel: "kernel-refactor-test" });
    const { experience } = await kernel.productServices.experienceService.createExperience("user-1", {
      title: "Platform migration",
      content: "Moved core frontend modules to TypeScript.",
    });
    const orchestrator = new AgentOrchestrator({ kernel });
    const ctx = createTestKernelContext({ user: { id: "user-1" }, request: { requestId: "req-1", traceId: "trace-1" } });

    const result = await orchestrator.handleChat(ctx, {
      message: "优化这份经历",
      clientState: { activeExperienceId: experience.id },
    });

    expect(JSON.stringify(result)).not.toContain("id is required");
    expect(result.raw.pendingActions?.[0]).toMatchObject({ toolName: "update_experience" });
    expect(result.raw.actionResults?.[0]?.status).toBe("needs_confirmation");
    await kernel.close();
  });
});

class KernelRefactorProvider implements LLMProvider {
  public readonly name = "kernel-refactor-test";

  public async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    const agentName = request.metadata?.agentName;
    const payload = readPayload(request);
    const message = String(payload.userMessage ?? "");
    if (agentName === "agent-core:frontdesk") {
      if (message === "那就生成吧") {
        return json({
          agentName: "frontdesk",
          responseType: "route",
          routeTo: "architect",
          assistantMessage: "",
          plan: [],
          missingInputs: [],
          confidence: 0.9,
          handoff: { intent: "resume.generate_from_jd", routeTo: "architect", extracted: {}, suggestedActions: ["generate_resume"], next: "execute_task" },
        });
      }
      if (message.includes("优化")) {
        return json({
          agentName: "frontdesk",
          responseType: "route",
          routeTo: "experience_receiver",
          assistantMessage: "",
          plan: [],
          missingInputs: [],
          confidence: 0.9,
          handoff: { intent: "experience.rewrite", routeTo: "experience_receiver", extracted: {}, suggestedActions: ["rewrite_experience"], next: "execute_task" },
        });
      }
      return json({
        agentName: "frontdesk",
        responseType: "route",
        routeTo: "strategist",
        assistantMessage: "",
        plan: [],
        missingInputs: [],
        confidence: 0.9,
        handoff: { intent: "jd.intake", routeTo: "strategist", extracted: { jdText: message, targetRole: "Senior Frontend Engineer" }, suggestedActions: ["save_jd", "analyze_jd", "generate_resume"], next: "handoff" },
      });
    }
    if (agentName === "agent-core:architect") {
      return json(plan("architect", "generate_resume_from_jd", {}, "Generate resume from JD."));
    }
    if (agentName === "agent-core:experience_receiver") {
      return json(plan("experience_receiver", "update_experience", { content: "优化后的经历内容" }, "Rewrite experience."));
    }
    if (agentName === "agent-core:critic") {
      return json({
        agentName: "critic",
        responseType: "final",
        assistantMessage: "pass",
        plan: [],
        missingInputs: [],
        confidence: 0.9,
        criticReview: {
          verdict: "pass",
          riskLevel: "low",
          unsupportedClaims: [],
          missingEvidence: [],
          suggestedFixes: [],
          userVisibleSummary: "pass",
        },
      });
    }
    return json(plan("strategist", "list_jds", {}, "List JDs."));
  }
}

function readPayload(request: LLMChatRequest): Record<string, unknown> {
  const text = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "{}";
  const parsed = JSON.parse(text) as unknown;
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function plan(agentName: string, toolName: string, args: Record<string, unknown>, summary: string): Record<string, unknown> {
  return {
    agentName,
    responseType: "plan",
    assistantMessage: "",
    plan: [{ id: "step-1", agentName, toolName, arguments: args, summary }],
    missingInputs: [],
    confidence: 0.9,
  };
}

function json(value: Record<string, unknown>): LLMChatResponse {
  return { content: JSON.stringify(value) };
}
