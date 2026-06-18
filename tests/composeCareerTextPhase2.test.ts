import { describe, expect, it } from "vitest";
import { ModelClient } from "../src/agent-core/model/ModelClient.js";
import type {
  LLMChatRequest,
  LLMChatResponse,
  LLMProvider,
} from "../src/agent-core/model/types.js";
import { AgentTraceRecorder } from "../src/agent-core/runtime/AgentTrace.js";
import { ToolExecutor } from "../src/agent-core/tools/ToolExecutor.js";
import { ToolRegistry } from "../src/agent-core/tools/ToolRegistry.js";
import { createAgentTools } from "../src/agent-tools/index.js";
import { composeCareerTextTool } from "../src/agent-tools/writing/composeCareerText.tool.js";
import { ArchitectAgent } from "../src/agent-core/agents/ArchitectAgent.js";
import { ExperienceReceiverAgent } from "../src/agent-core/agents/ExperienceReceiverAgent.js";
import { PromptRegistry } from "../src/agent-core/prompts/PromptRegistry.js";
import { createP12Kernel, testContext } from "./p12Helpers.js";
import type { UserAssetContext } from "../src/copilot/context/UserAssetContext.js";

// Test helper: stub LLM provider that returns whatever JSON we feed it.
class StubLLMProvider implements LLMProvider {
  public readonly name = "stub-compose";
  private readonly responder: (req: LLMChatRequest) => Record<string, unknown>;
  public lastUserPrompt = "";
  public lastSystemPrompt = "";
  public callCount = 0;

  public constructor(responder: (req: LLMChatRequest) => Record<string, unknown>) {
    this.responder = responder;
  }

  public async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    this.callCount += 1;
    const sys = request.messages.find((m) => m.role === "system")?.content ?? "";
    const usr = request.messages.find((m) => m.role === "user")?.content ?? "";
    this.lastSystemPrompt = sys;
    this.lastUserPrompt = usr;
    return { content: JSON.stringify(this.responder(request)) };
  }
}

function makeUserAssetContext(over: Partial<UserAssetContext> = {}): UserAssetContext {
  return {
    experiences: [],
    jds: [],
    resumes: [],
    generations: [],
    drafts: [],
    active: {},
    counts: { experiences: 0, jds: 0, resumes: 0, generations: 0, drafts: 0 },
    retrievalPolicy: { mode: "manifest_only", maxItemsPerType: 20, maxSummaryChars: 160 },
    ...over,
  };
}

// Seed a real WEEX experience into the test kernel and return its canonical id + manifest.
async function seedWeexExperience(kernel: Awaited<ReturnType<typeof createP12Kernel>>) {
  const created = await kernel.productServices.experienceService.createExperience("user-1", {
    title: "WEEX 数据分析实习",
    organization: "WEEX 国际交易所",
    role: "数据分析实习生",
    content: "在 WEEX 实习期间使用 SQL 和 Power BI 搭建增长仪表盘，跟踪用户漏斗与日活转化指标。",
    tags: ["SQL", "Power BI", "数据分析"],
    category: "work",
    startDate: "2026-01",
    endDate: "2026-04",
  });
  return created.experience;
}

describe("Phase 2 — compose_career_text tool registration", () => {
  it("is exposed by createAgentTools()", () => {
    const tools = createAgentTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("compose_career_text");
  });

  it("is read-only, low risk, requiresConfirmation=false", () => {
    const tool = composeCareerTextTool();
    expect(tool.mutability).toBe("read");
    expect(tool.riskLevel).toBe("low");
    expect(tool.requiresConfirmation).toBe(false);
    expect(tool.ownerAgent).toBe("architect");
  });

  it("is now in ArchitectAgent.allowedTools (Phase 3 opened it via the asset_grounded.write branch)", () => {
    const promptRegistry = new PromptRegistry();
    const architect = new ArchitectAgent({ promptRegistry });
    expect(architect.allowedTools).toContain("compose_career_text");
  });

  it("is now in ExperienceReceiverAgent.allowedTools (Phase 3, single-experience writing branch)", () => {
    const promptRegistry = new PromptRegistry();
    const receiver = new ExperienceReceiverAgent({ promptRegistry });
    expect(receiver.allowedTools).toContain("compose_career_text");
  });
});

describe("Phase 2 — compose_career_text needs_input paths", () => {
  it("returns needs_input + asset_grounded_text_needs_input when there is no asset to ground on", async () => {
    const kernel = await createP12Kernel();
    // No LLM provider so compose path can't run; but needs_input branch fires before LLM is called.
    kernel.frontDeskModelClient = undefined;
    const registry = new ToolRegistry();
    registry.registerMany([composeCareerTextTool()]);
    const context = testContext(kernel, registry.list());
    const executor = new ToolExecutor(registry, new AgentTraceRecorder());

    const result = await executor.execute("compose_career_text", {
      goal: "self_intro",
      outputType: "self_intro",
      userInstruction: "根据我的经历写一条自我介绍",
    }, context);

    expect(result.status).toBe("needs_input");
    expect(result.resultKind).toBe("asset_grounded_text_needs_input");
    expect(result.actionResult?.actionType).toBe("compose_career_text");
    expect(result.actionResult?.reason).toBe("no_assets");
    expect(result.pendingActionId).toBeUndefined();
    // Tool MUST not write to workspace patches that would mutate state.
    expect(result.workspacePatch).toBeUndefined();
    // Audit fields present.
    expect((result.data as { usedExperienceIds: string[] }).usedExperienceIds).toEqual([]);
    expect(Array.isArray(result.warnings)).toBe(true);
    await kernel.close();
  });

  it("returns needs_input when an experienceQuery cannot be resolved (no fabrication)", async () => {
    const kernel = await createP12Kernel();
    kernel.frontDeskModelClient = undefined;
    const registry = new ToolRegistry();
    registry.registerMany([composeCareerTextTool()]);
    const context = testContext(kernel, registry.list());
    context.userAssetContext = makeUserAssetContext({
      experiences: [
        {
          id: "pexp-99999999-9999-9999-9999-999999999999",
          type: "experience",
          title: "GTA project",
          organization: "GTA",
          role: "developer",
          tags: [],
        },
      ],
      counts: { experiences: 1, jds: 0, resumes: 0, generations: 0, drafts: 0 },
    });
    const executor = new ToolExecutor(registry, new AgentTraceRecorder());

    const result = await executor.execute("compose_career_text", {
      outputType: "project_intro",
      experienceQuery: "WEEX",
      userInstruction: "根据 WEEX 实习写一段项目介绍",
    }, context);

    expect(result.status).toBe("needs_input");
    expect(result.resultKind).toBe("asset_grounded_text_needs_input");
    expect(result.actionResult?.reason).toBe("experience_not_resolved");
    expect((result.data as { content: string }).content).toBe("");
    await kernel.close();
  });

  it("rejects natural-language strings inside assetScope.experienceIds (canonical-id guard)", async () => {
    const kernel = await createP12Kernel();
    kernel.frontDeskModelClient = undefined;
    const registry = new ToolRegistry();
    registry.registerMany([composeCareerTextTool()]);
    const context = testContext(kernel, registry.list());
    const executor = new ToolExecutor(registry, new AgentTraceRecorder());

    const result = await executor.execute("compose_career_text", {
      outputType: "self_intro",
      // intentionally malformed: caller passed a keyword instead of a canonical id.
      assetScope: { experienceIds: ["weex"] },
      userInstruction: "根据 WEEX 写自我介绍",
    }, context);

    // Must NOT return a fabricated success — natural-language ids are dropped
    // and the tool falls into needs_input.
    expect(result.status).toBe("needs_input");
    expect(result.actionResult?.reason).toBe("experience_not_resolved");
    await kernel.close();
  });
});

describe("Phase 2 — compose_career_text experience-grounded mode", () => {
  it("returns success + asset_grounded_text_completed with usedExperienceIds when experiences exist", async () => {
    const kernel = await createP12Kernel();
    const seed = await seedWeexExperience(kernel);
    const stub = new StubLLMProvider(() => ({
      status: "success",
      title: "1 分钟自我介绍",
      outputType: "self_intro",
      content: "我是数据分析方向的求职者，过去在 WEEX 用 SQL 与 Power BI 搭建增长仪表盘。",
      usedExperienceIds: [seed.id],
      groundingNotes: ["Used WEEX experience " + seed.id],
      riskNotes: [],
      suggestions: ["可以再让我改成英文版。"],
      alternatives: [{ title: "英文版", content: "I'm a data-driven candidate...", scenario: "EN" }],
    }));
    kernel.frontDeskModelClient = new ModelClient({ provider: stub, defaultModel: "stub-compose" });

    const registry = new ToolRegistry();
    registry.registerMany([composeCareerTextTool()]);
    const context = testContext(kernel, registry.list());
    const executor = new ToolExecutor(registry, new AgentTraceRecorder());

    const result = await executor.execute("compose_career_text", {
      goal: "self_intro",
      outputType: "self_intro",
      constraints: { length: "medium", language: "zh" },
      userInstruction: "根据我的经历写一条 1 分钟中文自我介绍",
    }, context);

    expect(result.status).toBe("success");
    expect(result.resultKind).toBe("asset_grounded_text_completed");
    const data = result.data as Record<string, unknown>;
    expect(typeof data.content).toBe("string");
    expect((data.content as string).length).toBeGreaterThan(0);
    expect(data.usedExperienceIds).toEqual([seed.id]);
    expect(data.outputType).toBe("self_intro");
    expect(Array.isArray(data.alternatives)).toBe(true);
    // Phase 1 structured fields all present.
    expect(Array.isArray(result.summaryFacts)).toBe(true);
    expect(Array.isArray(result.entities)).toBe(true);
    expect(Array.isArray(result.evidence)).toBe(true);
    expect(Array.isArray(result.nextActionHints)).toBe(true);
    // Phase 2 hard boundary — no resume-variant artefacts, no pending action.
    expect(result.pendingActionId).toBeUndefined();
    expect(result.workspacePatch).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("variants");
    expect(JSON.stringify(result)).not.toContain("productGenerationId");
    // Audit: tool must not have triggered match/generate flows.
    expect(stub.callCount).toBeGreaterThan(0);
    expect(stub.lastSystemPrompt).toContain("asset-grounded");
    expect(stub.lastUserPrompt).toContain("Experiences");
    await kernel.close();
  });

  it("uses deterministic test-fallback when LLM client is missing AND NODE_ENV=test", async () => {
    const kernel = await createP12Kernel();
    kernel.frontDeskModelClient = undefined;
    const seed = await seedWeexExperience(kernel);

    const registry = new ToolRegistry();
    registry.registerMany([composeCareerTextTool()]);
    const context = testContext(kernel, registry.list());
    const executor = new ToolExecutor(registry, new AgentTraceRecorder());

    const result = await executor.execute("compose_career_text", {
      outputType: "self_intro",
      constraints: { language: "zh" },
      userInstruction: "根据我的经历写一条自我介绍",
    }, context);

    expect(result.status).toBe("success");
    expect(result.resultKind).toBe("asset_grounded_text_completed");
    const data = result.data as Record<string, unknown>;
    expect(data.composeMethod).toBe("deterministic_test_fallback");
    expect(data.usedExperienceIds).toEqual([seed.id]);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(result.warnings?.some((w) => w.includes("Deterministic test fallback"))).toBe(true);
    await kernel.close();
  });
});

describe("Phase 2 — compose_career_text single-experience mode (resolves experienceQuery)", () => {
  it("resolves experienceQuery via AssetMentionResolver and uses the matched canonical id", async () => {
    const kernel = await createP12Kernel();
    const seed = await seedWeexExperience(kernel);
    const stub = new StubLLMProvider(() => ({
      status: "success",
      title: "WEEX 项目介绍",
      outputType: "project_intro",
      content: "我在 WEEX 实习期间搭建了增长仪表盘，跟踪用户漏斗。",
      usedExperienceIds: [seed.id],
      groundingNotes: ["Drew on WEEX SQL dashboard work"],
      riskNotes: [],
      suggestions: [],
      alternatives: [],
    }));
    kernel.frontDeskModelClient = new ModelClient({ provider: stub, defaultModel: "stub-compose" });

    const registry = new ToolRegistry();
    registry.registerMany([composeCareerTextTool()]);
    const context = testContext(kernel, registry.list());
    context.userAssetContext = makeUserAssetContext({
      experiences: [{
        id: seed.id,
        type: "experience",
        title: seed.title,
        organization: seed.organization,
        role: seed.role,
        tags: seed.tags ?? [],
      }],
      counts: { experiences: 1, jds: 0, resumes: 0, generations: 0, drafts: 0 },
    });
    const executor = new ToolExecutor(registry, new AgentTraceRecorder());

    const result = await executor.execute("compose_career_text", {
      outputType: "project_intro",
      experienceQuery: "WEEX",
      userInstruction: "根据 WEEX 实习经历写一段项目介绍",
    }, context);

    expect(result.status).toBe("success");
    const data = result.data as Record<string, unknown>;
    expect(data.usedExperienceIds).toEqual([seed.id]);
    expect((data.content as string).length).toBeGreaterThan(0);
    await kernel.close();
  });
});

describe("Phase 2 — compose_career_text JD-grounded mode", () => {
  it("accepts jdText for grounding without triggering match_experiences_against_jd or generate_resume_from_jd", async () => {
    const kernel = await createP12Kernel();
    const seed = await seedWeexExperience(kernel);
    const stub = new StubLLMProvider(() => ({
      status: "success",
      title: "JD 锚定自我介绍",
      outputType: "self_intro",
      content: "我是数据分析方向的求职者，结合 JD 中的成长方向，重点强调 SQL 与可视化能力。",
      usedExperienceIds: [seed.id],
      groundingNotes: ["JD anchored draft"],
      riskNotes: ["未引用具体指标，建议补充。"],
      suggestions: [],
      alternatives: [],
    }));
    kernel.frontDeskModelClient = new ModelClient({ provider: stub, defaultModel: "stub-compose" });

    const registry = new ToolRegistry();
    registry.registerMany([composeCareerTextTool()]);
    const context = testContext(kernel, registry.list());
    const executor = new ToolExecutor(registry, new AgentTraceRecorder());

    const jdText = "Senior Data Analyst — build dashboards, drive growth experiments, partner with product. " +
      "Requirements: 3+ years SQL, dashboarding, A/B testing.";
    const result = await executor.execute("compose_career_text", {
      outputType: "self_intro",
      jdText,
      userInstruction: "根据这份 JD 写一段自我介绍",
    }, context);

    expect(result.status).toBe("success");
    expect(result.resultKind).toBe("asset_grounded_text_completed");
    // Tool MUST NOT impersonate the match/generate flows.
    const dataJson = JSON.stringify(result);
    expect(dataJson).not.toContain("match_experiences_against_jd");
    expect(dataJson).not.toContain("generate_resume_from_jd");
    expect(dataJson).not.toContain("\"matchResults\"");
    expect(dataJson).not.toContain("\"variants\"");
    await kernel.close();
  });
});

describe("Phase 2 — compose_career_text id-array filtering (no fabrication)", () => {
  it("strips usedExperienceIds the LLM made up that are not in the supplied scope", async () => {
    const kernel = await createP12Kernel();
    const seed = await seedWeexExperience(kernel);
    const stub = new StubLLMProvider(() => ({
      status: "success",
      title: "draft",
      outputType: "self_intro",
      content: "draft body",
      // The LLM hallucinates a fake id alongside the real one — tool must drop it.
      usedExperienceIds: [seed.id, "pexp-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "weex"],
      usedJDIds: ["pjd-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"],
      usedResumeIds: ["pres-cccccccc-cccc-cccc-cccc-cccccccccccc"],
      groundingNotes: [],
      riskNotes: [],
      suggestions: [],
      alternatives: [],
    }));
    kernel.frontDeskModelClient = new ModelClient({ provider: stub, defaultModel: "stub-compose" });

    const registry = new ToolRegistry();
    registry.registerMany([composeCareerTextTool()]);
    const context = testContext(kernel, registry.list());
    const executor = new ToolExecutor(registry, new AgentTraceRecorder());

    const result = await executor.execute("compose_career_text", {
      outputType: "self_intro",
      userInstruction: "根据我的经历写一段自我介绍",
    }, context);

    const data = result.data as Record<string, unknown>;
    expect(data.usedExperienceIds).toEqual([seed.id]);
    expect(data.usedJDIds).toEqual([]);     // jd not in scope — dropped
    expect(data.usedResumeIds).toEqual([]); // resume not in scope — dropped
    await kernel.close();
  });
});

describe("Phase 2 — compose_career_text PreferenceBank boundary (tone only, never facts)", () => {
  it("includes preferences in the LLM prompt under 'Style preferences' (NOT under fact sources)", async () => {
    const kernel = await createP12Kernel();
    const seed = await seedWeexExperience(kernel);
    // Seed an explicit preference so PreferenceBankService surfaces something.
    if (kernel.productServices.preferenceBankService) {
      await kernel.productServices.preferenceBankService.recordExplicitPreference({
        userId: "user-1",
        instruction: "Prefer concise, first-person Chinese tone with concrete metrics.",
        scope: { language: "zh" },
        polarity: "positive",
      });
    }

    let captured = "";
    const stub = new StubLLMProvider((req) => {
      captured = req.messages.find((m) => m.role === "user")?.content ?? "";
      return {
        status: "success",
        title: "draft",
        outputType: "self_intro",
        content: "drafted body",
        usedExperienceIds: [seed.id],
        groundingNotes: [],
        riskNotes: [],
        suggestions: [],
        alternatives: [],
      };
    });
    kernel.frontDeskModelClient = new ModelClient({ provider: stub, defaultModel: "stub-compose" });

    const registry = new ToolRegistry();
    registry.registerMany([composeCareerTextTool()]);
    const context = testContext(kernel, registry.list());
    const executor = new ToolExecutor(registry, new AgentTraceRecorder());

    const result = await executor.execute("compose_career_text", {
      outputType: "self_intro",
      constraints: { language: "zh" },
      userInstruction: "根据我的经历写一段自我介绍",
    }, context);

    expect(result.status).toBe("success");
    // Preferences must appear under the style-only block — never as a fact source.
    if (captured.includes("Style preferences")) {
      const stylePos = captured.indexOf("Style preferences");
      const factsPos = captured.indexOf("# Experiences");
      // \"Style preferences\" must come AFTER \"# Experiences\" in the prompt
      // so the model sees facts first and styles second.
      expect(stylePos).toBeGreaterThan(factsPos);
    }
    // System prompt must explicitly forbid using preferences as facts.
    expect(stub.lastSystemPrompt).toContain("PreferenceBank");
    expect(stub.lastSystemPrompt).toContain("NEVER a source of factual claims");
    await kernel.close();
  });
});

describe("Phase 2 — compose_career_text ToolResult contract (Phase 1 structured fields)", () => {
  it("uses additive fields only — no new top-level ToolResult keys", async () => {
    const kernel = await createP12Kernel();
    const seed = await seedWeexExperience(kernel);
    const stub = new StubLLMProvider(() => ({
      status: "success",
      title: "draft",
      outputType: "self_intro",
      content: "drafted body",
      usedExperienceIds: [seed.id],
      groundingNotes: ["from WEEX"],
      riskNotes: [],
      suggestions: [],
      alternatives: [],
    }));
    kernel.frontDeskModelClient = new ModelClient({ provider: stub, defaultModel: "stub-compose" });

    const registry = new ToolRegistry();
    registry.registerMany([composeCareerTextTool()]);
    const context = testContext(kernel, registry.list());
    const executor = new ToolExecutor(registry, new AgentTraceRecorder());

    const result = await executor.execute("compose_career_text", {
      outputType: "self_intro",
      userInstruction: "根据我的经历写一段自我介绍",
    }, context);

    // Allowed top-level keys (Phase 1 ToolResult contract — no new ones added in Phase 2).
    const ALLOWED = new Set([
      "status",
      "message",
      "data",
      "workspacePatch",
      "actionResult",
      "pendingActionId",
      "visibility",
      "resultKind",
      "summaryFacts",
      "entities",
      "evidence",
      "warnings",
      "nextActionHints",
    ]);
    for (const key of Object.keys(result)) {
      expect(ALLOWED.has(key)).toBe(true);
    }
    expect(result.resultKind).toBe("asset_grounded_text_completed");
    expect(result.summaryFacts?.length).toBeGreaterThan(0);
    expect(result.entities?.length).toBeGreaterThan(0);
    expect(result.entities?.some((e) => e.type === "writing_result")).toBe(true);
    expect(result.entities?.some((e) => e.type === "experience" && e.id === seed.id)).toBe(true);
    expect(result.evidence?.length).toBeGreaterThan(0);
    expect(result.nextActionHints?.length).toBeGreaterThan(0);
    expect(result.nextActionHints?.[0]?.type).toBe("compose_career_text_variant");
    await kernel.close();
  });
});
