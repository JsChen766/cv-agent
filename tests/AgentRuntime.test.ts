import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelClient } from "../src/core/model/ModelClient.js";
import type { LLMProvider } from "../src/core/model/LLMProvider.js";
import type { LLMChatRequest, LLMChatResponse, LLMStreamChunk } from "../src/core/model/types.js";
import { createKernel } from "../src/api/kernel/createKernel.js";
import type { ApiKernel } from "../src/api/types.js";
import type { KernelRequestContext } from "../src/kernel/context.js";
import { AgentRuntime } from "../src/agents/runtime/AgentRuntime.js";
import { AgentDecisionSchema } from "../src/agents/schema/AgentDecision.js";
import { readAgentRuntimeConfig } from "../src/agents/runtime/AgentRuntimeConfig.js";

describe("AgentDecision schema", () => {
  it("accepts valid JSON decisions", () => {
    const parsed = AgentDecisionSchema.parse({
      mode: "call_tool",
      assistantMessage: "Opening your experience library.",
      toolCalls: [{ toolName: "list_experiences", arguments: {} }],
      confidence: 0.9,
    });
    expect(parsed.mode).toBe("call_tool");
  });

  it("rejects malformed decisions", () => {
    expect(() => AgentDecisionSchema.parse({
      mode: "call_tool",
      confidence: 2,
    })).toThrow();
  });
});

describe("AgentRuntime", () => {
  let kernel: ApiKernel;

  beforeEach(async () => {
    process.env.NODE_ENV = "test";
    process.env.AUTH_MODE = "dev_header";
    process.env.AGENT_PROVIDER = "mock";
    process.env.FRONTDESK_AGENT_MODE = "fake";
    process.env.EXPERIENCE_EXTRACTOR_MODE = "deterministic";
    process.env.ARTIFACT_GENERATOR_MODE = "deterministic";
    process.env.CRITIC_AGENT_MODE = "deterministic";
    process.env.REVISION_AGENT_MODE = "deterministic";
    delete process.env.DATABASE_URL;
    kernel = await createKernel();
  });

  afterEach(async () => {
    await kernel.close();
  });

  it("returns natural chat and suggested prompts from the fake test model", async () => {
    const runtime = new AgentRuntime({ kernel });
    const response = await runtime.handleChat(ctx(), { message: "Hello, what can you do?" });
    expect(response.assistantMessage.content).toContain("Coolto Copilot");
    expect(response.suggestedPrompts?.length).toBeGreaterThan(0);
  });

  it("executes a model-selected product tool", async () => {
    const runtime = new AgentRuntime({ kernel });
    const response = await runtime.handleChat(ctx(), { message: "Show my experience library." });
    expect(response.workspace.activePanel).toBe("experience_library");
  });

  it("generates variants from a tool call", async () => {
    const runtime = new AgentRuntime({ kernel });
    const response = await runtime.handleChat(ctx(), {
      message: "Generate resume content",
      jdText: "React TypeScript performance role.",
      targetRole: "Frontend Engineer",
    });
    expect(response.workspace.activePanel).toBe("variants");
    expect(response.workspace.variants.length).toBeGreaterThan(0);
  });

  it("turns invalid tool calls into a safe clarification", async () => {
    kernel.frontDeskModelClient = new ModelClient({
      provider: new InvalidToolProvider(),
      defaultModel: "invalid-tool",
    });
    const runtime = new AgentRuntime({ kernel });
    const response = await runtime.handleChat(ctx(), { message: "Run an unsafe internal tool." });
    expect(response.assistantMessage.kind).toBe("clarifying_question");
    expect(JSON.stringify(response)).not.toContain("tool_args");
  });

  it("does not allow mock runtime outside test unless explicitly enabled", () => {
    expect(() => readAgentRuntimeConfig({
      NODE_ENV: "development",
      AGENT_PROVIDER: "mock",
      FRONTDESK_AGENT_MODE: "fake",
    })).toThrow("Mock/fake Agent runtime is only allowed");
  });
});

function ctx(userId = "agent-runtime-user"): KernelRequestContext {
  return {
    user: { id: userId },
    auth: { mode: "dev_header" },
    request: { requestId: "req-agent-runtime", traceId: "trace-agent-runtime", source: "test" },
  };
}

class InvalidToolProvider implements LLMProvider {
  public readonly name = "invalid-tool";

  public async chat(_request: LLMChatRequest): Promise<LLMChatResponse> {
    return {
      content: JSON.stringify({
        mode: "call_tool",
        assistantMessage: "I will do that.",
        toolCalls: [{ toolName: "internal_prompt_dump", arguments: {} }],
        confidence: 0.9,
      }),
    };
  }

  public async *stream(_request: LLMChatRequest): AsyncIterable<LLMStreamChunk> {
    yield { contentDelta: "" };
  }
}
