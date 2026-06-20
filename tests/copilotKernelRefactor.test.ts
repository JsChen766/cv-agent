import { describe, expect, it } from "vitest";
import { ModelClient } from "../src/agent-core/model/ModelClient.js";
import type { LLMChatRequest, LLMChatResponse, LLMProvider } from "../src/agent-core/model/types.js";
import { AgentOrchestrator } from "../src/agent-core/runtime/AgentOrchestrator.js";
import { FrontDeskHandoffSchema } from "../src/copilot/handoff/FrontDeskHandoffSchema.js";
import { normalizeFrontDeskHandoff } from "../src/copilot/handoff/HandoffNormalizer.js";
import { applyHandoffToDrafts } from "../src/copilot/context/DraftContext.js";
import { ContextHydrator, toolNeedsInputMessageForFields } from "../src/copilot/context/ContextHydrator.js";
import { ResponseComposer } from "../src/copilot/response/ResponseComposer.js";
import type { CopilotWorkspace } from "../src/copilot/types.js";
import { createTestKernelContext } from "../src/api/context.js";
import { createP12Kernel } from "./p12Helpers.js";
import { makeScenarioProvider } from "./scenarioModelClient.js";

const JD_TEXT = `Senior Frontend Engineer
Company: Example Tech
Responsibilities:
- Build React and TypeScript product workflows.
- Collaborate with design, data, and backend teams.
Requirements:
- 5+ years frontend engineering experience.
- Strong ownership of complex user-facing systems.`;

const CN_GENERATE_JD_TEXT = `我要生成简历：岗位职责：
1.负责核心教学平台全栈开发：独立完成前端、后端、数据库全链路开发；2.负责系统部署与运维：使用Docker部署应用，监控系统性能并优化。
任职要求：
岗位要求
1.本科及以上学历，计算机相关专业；2.熟练掌握Vue/React前端框架及至少一门后端语言(Node.js/Python/Java/Go);3.精通MySQL/PostgreSQL数据库设计与SQL优化；4.熟练使用Docker进行容器化部署，掌握Linux常用命令与Nginx配置。`;

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

  it("accept_generation_variant returns field-specific missing-input messages", () => {
    // Both missing
    expect(toolNeedsInputMessageForFields("accept_generation_variant", ["generationId", "variantId"], undefined))
      .toContain("请先打开生成结果，并选择一个要保存的版本。");
    expect(toolNeedsInputMessageForFields("accept_generation_variant", ["generationId", "variantId"], "en"))
      .toContain("Please open a generation result and select a variant first.");

    // Only generationId missing
    expect(toolNeedsInputMessageForFields("accept_generation_variant", ["generationId"], undefined))
      .toContain("请先打开一次生成结果，或重新生成简历版本。");
    expect(toolNeedsInputMessageForFields("accept_generation_variant", ["generationId"], "en"))
      .toContain("Please open a generation result first, or regenerate resume versions.");

    // Only variantId missing
    expect(toolNeedsInputMessageForFields("accept_generation_variant", ["variantId"], undefined))
      .toContain("请先选择一个生成版本。");
    expect(toolNeedsInputMessageForFields("accept_generation_variant", ["variantId"], "en"))
      .toContain("Please select a generated variant first.");

    // Other tools unaffected
    expect(toolNeedsInputMessageForFields("get_experience", ["id"], undefined))
      .toContain("请先选择一条经历");
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

  it("routes explicit JD generation even when the frontdesk model wrongly returns final chat", async () => {
    const kernel = await createP12Kernel();
    kernel.frontDeskModelClient = new ModelClient({ provider: new FinalChatMisrouteProvider(), defaultModel: "misroute-test" });
    const orchestrator = new AgentOrchestrator({ kernel });
    const ctx = createTestKernelContext({ user: { id: "user-1" }, request: { requestId: "req-1", traceId: "trace-1" } });

    const generated = await orchestrator.handleChat(ctx, { message: CN_GENERATE_JD_TEXT });

    expect(generated.workspace.handoffs?.at(-1)?.intent).toBe("resume.generate_from_jd");
    expect(generated.workspace.handoffs?.at(-1)?.routeTo).toBe("architect");
    expect(generated.raw.pendingActions?.[0]).toMatchObject({ toolName: "generate_resume_from_jd" });
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

class FinalChatMisrouteProvider implements LLMProvider {
  public readonly name = "misroute-test";

  public async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    const agentName = request.metadata?.agentName;
    const payload = readPayload(request);
    const message = String(payload.userMessage ?? "");
    if (agentName === "agent-core:frontdesk") {
      return json({
        agentName: "frontdesk",
        responseType: "final",
        routeTo: "frontdesk",
        assistantMessage: "我是你的求职经历 Copilot，可以帮你整理经历、分析 JD、生成和修改简历。",
        plan: [],
        missingInputs: [],
        confidence: 0.8,
        handoff: { intent: "general.chat", routeTo: "frontdesk", extracted: {}, next: "answer_directly" },
      });
    }
    if (agentName === "agent-core:architect") {
      return json({
        agentName: "architect",
        responseType: "ask_clarification",
        assistantMessage: "我来处理你的请求。",
        plan: [],
        missingInputs: [],
        confidence: 0.4,
      });
    }
    return json(plan("strategist", "analyze_jd", { text: message }, "Analyze JD."));
  }
}

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
    if (agentName === "agent-core:strategist") {
      return json(plan("strategist", "analyze_jd", { text: message }, "Analyze JD."));
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
    return json(plan("strategist", "analyze_jd", { text: message }, "Analyze JD."));
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

describe("ENABLE_NARRATOR e2e through AgentResultAssembler", () => {
  it("uses narrator output on the accepted branch when ENABLE_NARRATOR=true", async () => {
    const original = process.env.ENABLE_NARRATOR;
    process.env.ENABLE_NARRATOR = "true";
    try {
      const kernel = await createP12Kernel();
      const provider = makeScenarioProvider({ narratorReply: "已保存这个版本到你的简历，可随时导出。" });
      kernel.frontDeskModelClient = new ModelClient({ provider, defaultModel: "scenario-narrator-stub" });
      const orchestrator = new AgentOrchestrator({ kernel });
      const ctx = createTestKernelContext({ user: { id: "user-1" }, request: { requestId: "narr-1", traceId: "narr-1" } });

      // Seed: directly generate variants via product service (bypasses pending),
      // then drive an accept through handleExplicitAction → confirmPendingAction.
      const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});
      const generated = await kernel.productServices.generationProductService.generateResumeFromJD({
        userId: "user-1",
        sessionId: session.id,
        jdText: "Senior Frontend Engineer with Vue 3.",
        targetRole: "Senior Frontend Engineer",
      });
      const variantId = generated.variants[0]!.id;

      const acceptIntent = await orchestrator.handleExplicitAction(ctx, {
        sessionId: session.id,
        action: { type: "accept", variantId, payload: { generationId: generated.generation.id } },
      });
      const pendingId = (acceptIntent.raw.pendingActions as Array<{ id: string }> | undefined)?.[0]?.id;
      expect(pendingId).toBeTruthy();

      const confirmed = await orchestrator.confirmPendingAction(ctx, pendingId!);
      // accept_generation_variant is the narrator `accepted` branch (sync, no `generating: true`).
      expect(confirmed.assistantMessage.content).toContain("已保存这个版本到你的简历");
      await kernel.close();
    } finally {
      if (original === undefined) delete process.env.ENABLE_NARRATOR;
      else process.env.ENABLE_NARRATOR = original;
    }
  });

  it("falls back to legacy text on the accepted branch when ENABLE_NARRATOR is unset", async () => {
    const original = process.env.ENABLE_NARRATOR;
    delete process.env.ENABLE_NARRATOR;
    try {
      const kernel = await createP12Kernel();
      const provider = makeScenarioProvider({ narratorReply: "narrator should NOT be used" });
      kernel.frontDeskModelClient = new ModelClient({ provider, defaultModel: "scenario-narrator-stub" });
      const orchestrator = new AgentOrchestrator({ kernel });
      const ctx = createTestKernelContext({ user: { id: "user-2" }, request: { requestId: "narr-2", traceId: "narr-2" } });

      const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-2", {});
      const generated = await kernel.productServices.generationProductService.generateResumeFromJD({
        userId: "user-2",
        sessionId: session.id,
        jdText: "Senior Frontend Engineer with Vue 3.",
        targetRole: "Senior Frontend Engineer",
      });
      const variantId = generated.variants[0]!.id;

      const acceptIntent = await orchestrator.handleExplicitAction(ctx, {
        sessionId: session.id,
        action: { type: "accept", variantId, payload: { generationId: generated.generation.id } },
      });
      const pendingId = (acceptIntent.raw.pendingActions as Array<{ id: string }> | undefined)?.[0]?.id;
      expect(pendingId).toBeTruthy();

      const confirmed = await orchestrator.confirmPendingAction(ctx, pendingId!);
      expect(confirmed.assistantMessage.content).not.toContain("narrator should NOT be used");
      expect(confirmed.assistantMessage.content.length).toBeGreaterThan(0);
      await kernel.close();
    } finally {
      if (original !== undefined) process.env.ENABLE_NARRATOR = original;
    }
  });
});
