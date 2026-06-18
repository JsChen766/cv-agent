import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ArchitectAgent } from "../src/agent-core/agents/ArchitectAgent.js";
import { ExperienceReceiverAgent } from "../src/agent-core/agents/ExperienceReceiverAgent.js";
import { ModelClient } from "../src/agent-core/model/ModelClient.js";
import type { LLMChatRequest, LLMChatResponse, LLMProvider } from "../src/agent-core/model/types.js";
import { PromptRegistry } from "../src/agent-core/prompts/PromptRegistry.js";
import { AgentTraceRecorder } from "../src/agent-core/runtime/AgentTrace.js";
import { ToolExecutor } from "../src/agent-core/tools/ToolExecutor.js";
import { ToolRegistry } from "../src/agent-core/tools/ToolRegistry.js";
import { composeCareerTextTool } from "../src/agent-tools/writing/composeCareerText.tool.js";
import { createAgentTools } from "../src/agent-tools/index.js";
import { createP12Kernel, testContext } from "./p12Helpers.js";

const PHASE3_FORBIDDEN = [
  "generate_resume_from_jd",
  "match_experiences_against_jd",
  "accept_generation_variant",
  "prepare_export_resume",
  "export_resume",
] as const;

class StubProvider implements LLMProvider {
  public readonly name = "stub-phase3";
  public lastSystem = "";
  public lastUser = "";
  public callCount = 0;
  public constructor(private readonly responder: (req: LLMChatRequest) => Record<string, unknown>) {}
  public async chat(req: LLMChatRequest): Promise<LLMChatResponse> {
    this.callCount += 1;
    this.lastSystem = req.messages.find((m) => m.role === "system")?.content ?? "";
    this.lastUser = req.messages.find((m) => m.role === "user")?.content ?? "";
    return { content: JSON.stringify(this.responder(req)) };
  }
}

function plan(agentName: "architect" | "experience_receiver", toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  return {
    agentName,
    responseType: "plan",
    assistantMessage: "",
    plan: [{ id: "step-1", agentName, toolName, arguments: args, summary: "stub plan" }],
    missingInputs: [],
    confidence: 0.85,
  };
}

// === A. allowedTools open ===
describe("Phase 3 — allowedTools open compose_career_text to specialists", () => {
  const promptRegistry = new PromptRegistry();

  it("ArchitectAgent.allowedTools includes compose_career_text", () => {
    const agent = new ArchitectAgent({ promptRegistry });
    expect(agent.allowedTools).toContain("compose_career_text");
  });

  it("ExperienceReceiverAgent.allowedTools includes compose_career_text", () => {
    const agent = new ExperienceReceiverAgent({ promptRegistry });
    expect(agent.allowedTools).toContain("compose_career_text");
  });

  it("Architect retains every Phase 2 fixed-pipeline tool (no regression)", () => {
    const agent = new ArchitectAgent({ promptRegistry });
    for (const t of [
      "match_experiences_against_jd",
      "get_resume",
      "list_resumes",
      "generate_resume_from_jd",
      "accept_generation_variant",
      "revise_resume_item",
      "prepare_export_resume",
      "export_resume",
      "get_export",
    ]) expect(agent.allowedTools).toContain(t);
  });

  it("ExperienceReceiver retains every Phase 2 fixed tool (no regression)", () => {
    const agent = new ExperienceReceiverAgent({ promptRegistry });
    for (const t of [
      "list_experiences",
      "match_experience",
      "match_experiences_against_jd",
      "search_experiences",
      "get_experience",
      "import_experience_candidates_from_text",
      "import_resume_file_as_candidates",
      "accept_import_candidate",
      "reject_import_candidate",
      "prepare_save_experience_from_text",
      "save_experience_from_text",
      "prepare_save_jd_from_text",
      "save_jd_from_text",
      "prepare_update_experience",
      "update_experience",
      "prepare_delete_experience",
      "delete_experience",
    ]) expect(agent.allowedTools).toContain(t);
  });

  it("compose_career_text remains read-only / low-risk / no-confirmation", () => {
    const tool = composeCareerTextTool();
    expect(tool.mutability).toBe("read");
    expect(tool.requiresConfirmation).toBe(false);
    expect(tool.riskLevel).toBe("low");
  });

  it("compose_career_text is exposed by createAgentTools()", () => {
    const names = createAgentTools().map((t) => t.name);
    expect(names).toContain("compose_career_text");
  });
});

// === B. Architect asset-grounded writing plan tests ===
describe("Phase 3 — Architect plans compose_career_text on asset_grounded.write", () => {
  const promptRegistry = new PromptRegistry();

  async function runArchitect(userMessage: string, stub: Record<string, unknown>) {
    const kernel = await createP12Kernel();
    const provider = new StubProvider(() => stub);
    const modelClient = new ModelClient({ provider, defaultModel: "stub-phase3" });
    const agent = new ArchitectAgent({ modelClient, promptRegistry });
    const ctx = testContext(kernel, []);
    const decision = await agent.decide({
      context: { ...ctx, userMessage },
      routeHint: "architect",
    });
    await kernel.close();
    return { decision, provider };
  }

  it("self-intro request returns compose_career_text and forbidden tools are absent", async () => {
    const { decision } = await runArchitect(
      "根据我的经历帮我写一条自我介绍",
      plan("architect", "compose_career_text", {
        goal: "self_intro",
        outputType: "self_intro",
        userInstruction: "根据我的经历帮我写一条自我介绍",
        constraints: { length: "medium", language: "zh" },
      }),
    );
    expect(decision.responseType).toBe("plan");
    expect(decision.plan[0]?.toolName).toBe("compose_career_text");
    const tools = decision.plan.map((s) => s.toolName);
    for (const f of PHASE3_FORBIDDEN) expect(tools).not.toContain(f);
  });

  it("JD-anchored self-intro plans compose_career_text with jdText, no match/generate", async () => {
    const jdText = "Senior Data Analyst — build dashboards, partner with product, drive growth experiments.";
    const { decision } = await runArchitect(
      "根据这份 JD 写一段自我介绍：" + jdText,
      plan("architect", "compose_career_text", {
        goal: "self_intro",
        outputType: "self_intro",
        userInstruction: "根据这份 JD 写一段自我介绍：" + jdText,
        jdText,
      }),
    );
    expect(decision.plan[0]?.toolName).toBe("compose_career_text");
    expect((decision.plan[0]?.arguments as { jdText?: string }).jdText).toContain("Senior Data Analyst");
    const tools = decision.plan.map((s) => s.toolName);
    expect(tools).not.toContain("match_experiences_against_jd");
    expect(tools).not.toContain("generate_resume_from_jd");
  });

  it("profile-summary plans compose_career_text, never falls into resume generation", async () => {
    const { decision } = await runArchitect(
      "根据我的经历总结一下个人优势",
      plan("architect", "compose_career_text", {
        goal: "profile_summary",
        outputType: "profile_summary",
        userInstruction: "根据我的经历总结一下个人优势",
      }),
    );
    expect(decision.plan[0]?.toolName).toBe("compose_career_text");
    const args = decision.plan[0]?.arguments as { outputType?: string };
    expect(["profile_summary", "custom"]).toContain(args.outputType ?? "custom");
    const tools = decision.plan.map((s) => s.toolName);
    for (const f of PHASE3_FORBIDDEN) expect(tools).not.toContain(f);
  });

  it("Architect compose_career_text plan satisfies allowedTools enforcement", async () => {
    const agent = new ArchitectAgent({
      modelClient: new ModelClient({
        provider: new StubProvider(() =>
          plan("architect", "compose_career_text", { goal: "self_intro", outputType: "self_intro", userInstruction: "x" }),
        ),
        defaultModel: "stub-phase3",
      }),
      promptRegistry,
    });
    const kernel = await createP12Kernel();
    const decision = await agent.decide({ context: testContext(kernel, []), routeHint: "architect" });
    for (const step of decision.plan) {
      if (step.toolName) expect(agent.allowedTools).toContain(step.toolName);
    }
    await kernel.close();
  });
});

// === C. ExperienceReceiver single-experience writing tests ===
describe("Phase 3 — ExperienceReceiver plans compose_career_text on single-experience writing", () => {
  const promptRegistry = new PromptRegistry();

  async function runReceiver(userMessage: string, stub: Record<string, unknown>) {
    const kernel = await createP12Kernel();
    const provider = new StubProvider(() => stub);
    const modelClient = new ModelClient({ provider, defaultModel: "stub-phase3" });
    const agent = new ExperienceReceiverAgent({ modelClient, promptRegistry });
    const ctx = testContext(kernel, []);
    const decision = await agent.decide({ context: { ...ctx, userMessage }, routeHint: "experience_receiver" });
    await kernel.close();
    return decision;
  }

  it("WEEX project intro plans compose_career_text with experienceQuery, no save/update", async () => {
    const decision = await runReceiver(
      "根据 WEEX 实习经历写一段面试项目介绍",
      plan("experience_receiver", "compose_career_text", {
        goal: "project_intro",
        outputType: "project_intro",
        userInstruction: "根据 WEEX 实习经历写一段面试项目介绍",
        experienceQuery: "WEEX",
      }),
    );
    expect(decision.plan[0]?.toolName).toBe("compose_career_text");
    const args = decision.plan[0]?.arguments as { experienceQuery?: string };
    expect((args.experienceQuery ?? "").toUpperCase()).toContain("WEEX");
    const tools = decision.plan.map((s) => s.toolName);
    expect(tools).not.toContain("save_experience_from_text");
    expect(tools).not.toContain("update_experience");
    expect(tools).not.toContain("prepare_save_experience_from_text");
    expect(tools).not.toContain("prepare_update_experience");
    expect(tools).not.toContain("delete_experience");
  });

  it("'优化这条经历并保存' keeps the original rewrite/update path (does NOT switch to compose_career_text)", async () => {
    const decision = await runReceiver(
      "优化这条经历并保存",
      plan("experience_receiver", "update_experience", { content: "rewritten content" }),
    );
    expect(decision.plan[0]?.toolName).toBe("update_experience");
    const tools = decision.plan.map((s) => s.toolName);
    expect(tools).not.toContain("compose_career_text");
  });
});

// === D. Fixed pipeline regression ===
describe("Phase 3 — Existing fixed pipelines remain intact (regression)", () => {
  const promptRegistry = new PromptRegistry();

  async function runArchitect(userMessage: string, stub: Record<string, unknown>) {
    const kernel = await createP12Kernel();
    const provider = new StubProvider(() => stub);
    const modelClient = new ModelClient({ provider, defaultModel: "stub-phase3" });
    const agent = new ArchitectAgent({ modelClient, promptRegistry });
    const ctx = testContext(kernel, []);
    const decision = await agent.decide({ context: { ...ctx, userMessage }, routeHint: "architect" });
    await kernel.close();
    return decision;
  }

  async function runReceiver(userMessage: string, stub: Record<string, unknown>) {
    const kernel = await createP12Kernel();
    const provider = new StubProvider(() => stub);
    const modelClient = new ModelClient({ provider, defaultModel: "stub-phase3" });
    const agent = new ExperienceReceiverAgent({ modelClient, promptRegistry });
    const ctx = testContext(kernel, []);
    const decision = await agent.decide({ context: { ...ctx, userMessage }, routeHint: "experience_receiver" });
    await kernel.close();
    return decision;
  }

  it("'帮我看哪些经历最匹配这份 JD' keeps match_experiences_against_jd path", async () => {
    const decision = await runReceiver(
      "帮我看哪些经历最匹配这份 JD：Senior Data Analyst",
      plan("experience_receiver", "match_experiences_against_jd", { jdText: "Senior Data Analyst", limit: 20 }),
    );
    const tools = decision.plan.map((s) => s.toolName);
    expect(tools).toContain("match_experiences_against_jd");
    expect(tools).not.toContain("compose_career_text");
  });

  it("'基于这个 JD 生成简历' keeps generate_resume_from_jd path", async () => {
    const decision = await runArchitect(
      "基于这个 JD 生成简历：Senior Data Analyst",
      plan("architect", "generate_resume_from_jd", { jdText: "Senior Data Analyst" }),
    );
    const tools = decision.plan.map((s) => s.toolName);
    expect(tools).toContain("generate_resume_from_jd");
    expect(tools).not.toContain("compose_career_text");
  });

  it("'导出这份简历' keeps export_resume / prepare_export_resume path", async () => {
    const decision = await runArchitect(
      "导出这份简历",
      plan("architect", "prepare_export_resume", {}),
    );
    const tools = decision.plan.map((s) => s.toolName);
    expect(tools.some((n) => n === "prepare_export_resume" || n === "export_resume")).toBe(true);
    expect(tools).not.toContain("compose_career_text");
  });

  it("'接受这个版本' keeps accept_generation_variant path", async () => {
    const decision = await runArchitect(
      "接受这个版本",
      plan("architect", "accept_generation_variant", {}),
    );
    const tools = decision.plan.map((s) => s.toolName);
    expect(tools).toContain("accept_generation_variant");
    expect(tools).not.toContain("compose_career_text");
  });
});

// === E. Tool execution integration ===
describe("Phase 3 — End-to-end: Architect plan executes compose_career_text", () => {
  const promptRegistry = new PromptRegistry();

  it("Architect plan -> ToolExecutor produces asset_grounded_text contract without pendingAction/workspacePatch", async () => {
    const kernel = await createP12Kernel();
    // Seed an experience so the tool has grounding.
    const seed = await kernel.productServices.experienceService.createExperience("user-1", {
      title: "WEEX 数据分析实习",
      organization: "WEEX 国际交易所",
      role: "数据分析实习生",
      content: "在 WEEX 实习期间使用 SQL 和 Power BI 搭建增长仪表盘。",
      tags: ["SQL", "Power BI"],
      category: "work",
      startDate: "2026-01",
      endDate: "2026-04",
    });

    // Stub LLM that drives BOTH the architect decision and the tool body.
    const composeResponse = {
      status: "success",
      title: "1 分钟自我介绍",
      outputType: "self_intro",
      content: "我是数据分析方向的求职者，过去在 WEEX 用 SQL 与 Power BI 搭建增长仪表盘。",
      usedExperienceIds: [seed.experience.id],
      groundingNotes: ["Grounded on WEEX experience " + seed.experience.id],
      riskNotes: [],
      suggestions: [],
      alternatives: [],
    };
    const decisionResponse = plan("architect", "compose_career_text", {
      goal: "self_intro",
      outputType: "self_intro",
      userInstruction: "根据我的经历帮我写一条 1 分钟自我介绍",
      constraints: { length: "medium", language: "zh" },
    });

    const provider = new StubProvider((req) => {
      // Distinguish the agent decision call (metadata.agentName starts with "agent-core:")
      // from the compose_career_text tool's own LLM call.
      if (req.metadata?.agentName === "agent-core:architect") return decisionResponse;
      return composeResponse;
    });
    kernel.frontDeskModelClient = new ModelClient({ provider, defaultModel: "stub-phase3" });

    const agent = new ArchitectAgent({ modelClient: kernel.frontDeskModelClient, promptRegistry });
    const tools = createAgentTools();
    const registry = new ToolRegistry();
    registry.registerMany(tools);
    const context = testContext(kernel, registry.list());

    const decision = await agent.decide({
      context: { ...context, userMessage: "根据我的经历帮我写一条 1 分钟自我介绍" },
      routeHint: "architect",
    });
    expect(decision.plan[0]?.toolName).toBe("compose_career_text");

    const executor = new ToolExecutor(registry, new AgentTraceRecorder());
    const result = await executor.execute(
      "compose_career_text",
      decision.plan[0]?.arguments ?? {},
      context,
    );

    expect(result.status).toBe("success");
    expect(["asset_grounded_text_completed", "asset_grounded_text_needs_input"]).toContain(result.resultKind);
    const data = result.data as Record<string, unknown>;
    expect(typeof data.content).toBe("string");
    expect(Array.isArray(data.usedExperienceIds)).toBe(true);
    expect(Array.isArray(result.summaryFacts)).toBe(true);
    expect(Array.isArray(result.entities)).toBe(true);
    expect(Array.isArray(result.nextActionHints)).toBe(true);
    // Hard Phase-3 boundaries
    expect(result.pendingActionId).toBeUndefined();
    expect(result.workspacePatch).toBeUndefined();
    const json = JSON.stringify(result);
    expect(json).not.toContain("\"variants\"");
    expect(json).not.toContain("\"productGenerationId\"");
    expect(json).not.toContain("export_job");

    await kernel.close();
  });
});

// === F. Prompt-vs-allowedTools alignment ===
describe("Phase 3 — prompt files document compose_career_text under allowedTools", () => {
  it("architect.md mentions compose_career_text and the asset_grounded.write branch", () => {
    const url = new URL("../src/agent-core/prompts/prompts/architect.md", import.meta.url);
    const txt = readFileSync(url, "utf8");
    expect(txt).toContain("compose_career_text");
    expect(txt).toContain("asset_grounded.write");
    // Must explicitly forbid the dangerous pipelines in this branch.
    expect(txt).toContain("generate_resume_from_jd");
    expect(txt).toContain("match_experiences_against_jd");
    expect(txt).toContain("accept_generation_variant");
    expect(txt).toContain("export_resume");
  });

  it("experience-receiver.md mentions compose_career_text and the read-only boundary", () => {
    const url = new URL("../src/agent-core/prompts/prompts/experience-receiver.md", import.meta.url);
    const txt = readFileSync(url, "utf8");
    expect(txt).toContain("compose_career_text");
    expect(txt.toLowerCase()).toContain("read-only");
  });
});
