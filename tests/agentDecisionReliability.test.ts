import { describe, expect, it } from "vitest";
import { PromptRegistry } from "../src/agent-core/prompts/PromptRegistry.js";
import { FrontDeskAgent } from "../src/agent-core/agents/FrontDeskAgent.js";
import { ExperienceReceiverAgent } from "../src/agent-core/agents/ExperienceReceiverAgent.js";
import { ArchitectAgent } from "../src/agent-core/agents/ArchitectAgent.js";
import { CriticAgent } from "../src/agent-core/agents/CriticAgent.js";
import { StrategistAgent } from "../src/agent-core/agents/StrategistAgent.js";
import { createAgentTools } from "../src/agent-tools/index.js";
import type { LLMChatResponse, LLMProvider } from "../src/agent-core/model/types.js";
import { ModelClient } from "../src/agent-core/model/ModelClient.js";
import { AgentDecisionSchema, repairAgentDecision } from "../src/agent-core/validation/AgentOutputSchemas.js";
import { testContext } from "./p12Helpers.js";
import { createP12Kernel } from "./p12Helpers.js";

const prompts = new PromptRegistry();
const tools = createAgentTools();

function provider(handler: (agentName: string) => Record<string, unknown>): ModelClient {
  return new ModelClient({
    provider: {
      name: "test-provider",
      async chat(request) {
        const meta = request.metadata as { agentName?: string } | undefined;
        const value = handler(meta?.agentName ?? "unknown");
        return { content: JSON.stringify(value) } as LLMChatResponse;
      },
    } satisfies LLMProvider,
    defaultModel: "test-model",
  });
}

describe("agentDecisionReliability", () => {
  describe("FrontDeskAgent without modelClient", () => {
    it("does not throw and returns a fallback decision", async () => {
      const kernel = await createP12Kernel();
      const agent = new FrontDeskAgent({ promptRegistry: prompts });
      const ctx = testContext(kernel, tools);
      const ctxWithMsg = { ...ctx, userMessage: "你好" };
      const result = await agent.decide({ context: ctxWithMsg });
      expect(result.agentName).toBe("frontdesk");
      expect(result.responseType).toBe("final");
      expect(result.assistantMessage).toBeTruthy();
      expect(result.plan).toEqual([]);
      await kernel.close();
    });

    it("routes experience queries even without modelClient", async () => {
      const kernel = await createP12Kernel();
      const agent = new FrontDeskAgent({ promptRegistry: prompts });
      const ctx = testContext(kernel, tools);
      const ctxWithMsg = { ...ctx, userMessage: "我想查看下我的经历库" };
      const result = await agent.decide({ context: ctxWithMsg });
      expect(result.agentName).toBe("frontdesk");
      expect(result.responseType).toBe("route");
      expect(result.routeTo).toBe("experience_receiver");
      await kernel.close();
    });

    it("routes save experience intent even without modelClient", async () => {
      const kernel = await createP12Kernel();
      const agent = new FrontDeskAgent({ promptRegistry: prompts });
      const ctx = testContext(kernel, tools);
      const ctxWithMsg = { ...ctx, userMessage: "这是我的经历：我在 WEEX 做数据分析实习，写 SQL 和 Power BI。帮我保存下" };
      const result = await agent.decide({ context: ctxWithMsg });
      expect(result.agentName).toBe("frontdesk");
      expect(result.responseType).toBe("route");
      expect(result.routeTo).toBe("experience_receiver");
      await kernel.close();
    });
  });

  describe("FrontDeskAgent with bad JSON output", () => {
    it("repairs incomplete JSON into a valid decision", async () => {
      const kernel = await createP12Kernel();
      const badClient = provider(() => ({
        agentName: "frontdesk",
        responseType: "final",
        // missing assistantMessage, missing plan, missing missingInputs, missing confidence
      }));
      const agent = new FrontDeskAgent({ modelClient: badClient, promptRegistry: prompts });
      const ctx = testContext(kernel, tools);
      const ctxWithMsg = { ...ctx, userMessage: "hello" };
      const result = await agent.decide({ context: ctxWithMsg });
      expect(result.agentName).toBe("frontdesk");
      expect(result.responseType).toBe("final");
      expect(result.assistantMessage).toBeTruthy();
      expect(Array.isArray(result.plan)).toBe(true);
      expect(Array.isArray(result.missingInputs)).toBe(true);
      expect(typeof result.confidence).toBe("number");
      await kernel.close();
    });

    it("returns final response for casual chat", async () => {
      const kernel = await createP12Kernel();
      const client = provider(() => ({
        agentName: "frontdesk",
        responseType: "final",
        assistantMessage: "我是你的求职 Copilot。",
        plan: [],
        missingInputs: [],
        confidence: 0.9,
      }));
      const agent = new FrontDeskAgent({ modelClient: client, promptRegistry: prompts });
      const ctx = testContext(kernel, tools);
      const ctxWithMsg = { ...ctx, userMessage: "你好" };
      const result = await agent.decide({ context: ctxWithMsg });
      expect(result.responseType).toBe("final");
      expect(result.assistantMessage).toContain("Copilot");
      await kernel.close();
    });

    it("does not produce 'cannot safely' message on schema failure", async () => {
      const kernel = await createP12Kernel();
      const badClient = provider(() => ({ invalid: true }));
      const agent = new FrontDeskAgent({ modelClient: badClient, promptRegistry: prompts });
      const ctx = testContext(kernel, tools);
      const ctxWithMsg = { ...ctx, userMessage: "hello" };
      const result = await agent.decide({ context: ctxWithMsg });
      expect(result.assistantMessage).not.toContain("cannot safely");
      expect(result.assistantMessage).not.toContain("I could not");
      await kernel.close();
    });
  });

  describe("ExperienceReceiverAgent fallback", () => {
    it("generates list_experiences plan for viewing library", async () => {
      const kernel = await createP12Kernel();
      const agent = new ExperienceReceiverAgent({ promptRegistry: prompts });
      const ctx = testContext(kernel, tools);
      const ctxWithMsg = { ...ctx, userMessage: "我想查看下我的经历库" };
      const result = await agent.decide({ context: ctxWithMsg });
      expect(result.agentName).toBe("experience_receiver");
      expect(result.responseType).toBe("plan");
      expect(result.plan.length).toBeGreaterThanOrEqual(1);
      expect(result.plan[0].toolName).toBe("list_experiences");
      await kernel.close();
    });

    it("generates import_experience_candidates_from_text plan for saving experience", async () => {
      const kernel = await createP12Kernel();
      const agent = new ExperienceReceiverAgent({ promptRegistry: prompts });
      const ctx = testContext(kernel, tools);
      const ctxWithMsg = {
        ...ctx,
        userMessage: "这是我的经历：我在 WEEX 做数据分析实习，写 SQL 和 Power BI，看活动数据。帮我保存",
      };
      const result = await agent.decide({ context: ctxWithMsg });
      expect(result.agentName).toBe("experience_receiver");
      expect(result.plan.length).toBeGreaterThanOrEqual(1);
      expect(result.plan[0].toolName).toBe("import_experience_candidates_from_text");
      await kernel.close();
    });

    it("returns safe default plan when save text is too short", async () => {
      const kernel = await createP12Kernel();
      const agent = new ExperienceReceiverAgent({ promptRegistry: prompts });
      const ctx = testContext(kernel, tools);
      const ctxWithMsg = { ...ctx, userMessage: "保存" };
      const result = await agent.decide({ context: ctxWithMsg });
      // Simplified fallback: message too short to parse intent → safe default
      expect(result.agentName).toBe("experience_receiver");
      expect(result.plan.length).toBeGreaterThanOrEqual(1);
      expect(result.plan[0].toolName).toBe("list_experiences");
      expect(result.assistantMessage).not.toContain("cannot safely");
      await kernel.close();
    });
  });

  describe("Other agents fallback", () => {
    it("ArchitectAgent generates prepare_export_resume for export", async () => {
      const kernel = await createP12Kernel();
      const agent = new ArchitectAgent({ promptRegistry: prompts });
      const ctx = testContext(kernel, tools);
      const ctxWithMsg = { ...ctx, userMessage: "我想导出简历" };
      const result = await agent.decide({ context: ctxWithMsg });
      expect(result.agentName).toBe("architect");
      expect(result.plan.length).toBeGreaterThanOrEqual(1);
      const toolNames = result.plan.map((s) => s.toolName);
      expect(toolNames.some((n) => n === "prepare_export_resume" || n === "export_resume")).toBe(true);
      await kernel.close();
    });

    it("CriticAgent generates check_unsupported_claims for evidence questions", async () => {
      const kernel = await createP12Kernel();
      const agent = new CriticAgent({ promptRegistry: prompts });
      const ctx = testContext(kernel, tools);
      const ctxWithMsg = { ...ctx, userMessage: "我的经历真实吗" };
      const result = await agent.decide({ context: ctxWithMsg });
      expect(result.agentName).toBe("critic");
      expect(result.plan.length).toBeGreaterThanOrEqual(1);
      const toolNames = result.plan.map((s) => s.toolName);
      expect(toolNames.some((n) => n === "check_unsupported_claims" || n === "show_evidence")).toBe(true);
      await kernel.close();
    });

    it("StrategistAgent generates list_experiences for JD analysis", async () => {
      const kernel = await createP12Kernel();
      const agent = new StrategistAgent({ promptRegistry: prompts });
      const ctx = testContext(kernel, tools);
      const ctxWithMsg = { ...ctx, userMessage: "分析一下这个JD" };
      const result = await agent.decide({ context: ctxWithMsg });
      expect(result.agentName).toBe("strategist");
      expect(result.plan.length).toBeGreaterThanOrEqual(1);
      await kernel.close();
    });
  });

  describe("repairAgentDecision edge cases", () => {
    it("accepts optional criticReview in AgentDecisionSchema", () => {
      const parsed = AgentDecisionSchema.safeParse({
        agentName: "critic",
        responseType: "final",
        assistantMessage: "Review complete.",
        plan: [],
        missingInputs: [],
        confidence: 0.9,
        criticReview: {
          verdict: "needs_revision",
          riskLevel: "medium",
          unsupportedClaims: ["unsupported metric"],
          missingEvidence: ["source"],
          suggestedFixes: ["Use conservative wording."],
          userVisibleSummary: "Please revise unsupported claims.",
        },
      });

      expect(parsed.success).toBe(true);
      expect(parsed.success ? parsed.data.criticReview?.verdict : undefined).toBe("needs_revision");
    });

    it("preserves valid criticReview during repair", () => {
      const repaired = repairAgentDecision({
        agentName: "critic",
        responseType: "final",
        assistantMessage: "Review complete.",
        plan: [],
        missingInputs: [],
        confidence: 0.9,
        criticReview: {
          verdict: "blocked",
          riskLevel: "high",
          unsupportedClaims: ["unsupported metric"],
          missingEvidence: ["source"],
          suggestedFixes: ["Remove unsupported metric."],
          userVisibleSummary: "This needs evidence before use.",
        },
      }, "critic");

      expect(repaired?.criticReview?.verdict).toBe("blocked");
    });

    it("ignores invalid criticReview during repair without breaking the decision", () => {
      const repaired = repairAgentDecision({
        agentName: "architect",
        responseType: "final",
        assistantMessage: "Done.",
        plan: [],
        missingInputs: [],
        confidence: 0.9,
        criticReview: { verdict: "not-a-verdict" },
      }, "architect");

      expect(repaired?.responseType).toBe("final");
      expect(repaired?.criticReview).toBeUndefined();
    });

    it("repairs plan steps with missing id", async () => {
      const kernel = await createP12Kernel();
      const badClient = provider(() => ({
        agentName: "experience_receiver",
        responseType: "plan",
        assistantMessage: "test",
        plan: [
          { agentName: "experience_receiver", toolName: "list_experiences", arguments: {}, summary: "list" },
        ],
        missingInputs: [],
        confidence: 0.8,
      }));
      const agent = new ExperienceReceiverAgent({ modelClient: badClient, promptRegistry: prompts });
      const ctx = testContext(kernel, tools);
      const ctxWithMsg = { ...ctx, userMessage: "查看经历库" };
      const result = await agent.decide({ context: ctxWithMsg });
      expect(result.plan[0].id).toBeTruthy();
      await kernel.close();
    });

    it("repairs plan steps with missing agentName", async () => {
      const kernel = await createP12Kernel();
      const badClient = provider(() => ({
        agentName: "experience_receiver",
        responseType: "plan",
        assistantMessage: "test",
        plan: [
          { id: "step-1", toolName: "list_experiences", arguments: {}, summary: "list" },
        ],
        missingInputs: [],
        confidence: 0.8,
      }));
      const agent = new ExperienceReceiverAgent({ modelClient: badClient, promptRegistry: prompts });
      const ctx = testContext(kernel, tools);
      const ctxWithMsg = { ...ctx, userMessage: "查看经历库" };
      const result = await agent.decide({ context: ctxWithMsg });
      expect(result.plan[0].agentName).toBe("experience_receiver");
      await kernel.close();
    });

    it("repairs plan steps with missing arguments", async () => {
      const kernel = await createP12Kernel();
      const badClient = provider(() => ({
        agentName: "experience_receiver",
        responseType: "plan",
        assistantMessage: "test",
        plan: [
          { id: "step-1", agentName: "experience_receiver", toolName: "list_experiences", summary: "list" },
        ],
        missingInputs: [],
        confidence: 0.8,
      }));
      const agent = new ExperienceReceiverAgent({ modelClient: badClient, promptRegistry: prompts });
      const ctx = testContext(kernel, tools);
      const ctxWithMsg = { ...ctx, userMessage: "查看经历库" };
      const result = await agent.decide({ context: ctxWithMsg });
      expect(result.plan[0].arguments).toBeDefined();
      expect(typeof result.plan[0].arguments).toBe("object");
      await kernel.close();
    });
  });
});
