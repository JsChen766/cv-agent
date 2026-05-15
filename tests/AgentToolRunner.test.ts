import { describe, expect, it } from "vitest";
import { AgentToolRunner } from "../src/core/agent/AgentToolRunner.js";
import { BaseAgent } from "../src/core/agent/BaseAgent.js";
import { ConversationSession } from "../src/core/conversation/ConversationSession.js";
import { ModelClient } from "../src/core/model/ModelClient.js";
import type { LLMProvider } from "../src/core/model/LLMProvider.js";
import type { LLMChatRequest, LLMChatResponse } from "../src/core/model/types.js";
import { ToolExecutor } from "../src/core/tool/ToolExecutor.js";
import type { ToolCall } from "../src/core/tool/types.js";
import { echoTool } from "../src/tools/echoTool.js";
import { getCurrentTimeTool } from "../src/tools/getCurrentTimeTool.js";

class TestAgent extends BaseAgent {
  public constructor(modelClient: ModelClient) {
    super({
      name: "test-agent",
      role: "Test agent",
      systemPrompt: "Use tools when useful.",
      modelClient,
      tools: [echoTool, getCurrentTimeTool]
    });
  }
}

class FakeToolCallingProvider implements LLMProvider {
  public readonly name = "fake-tool-calling";
  public readonly requests: LLMChatRequest[] = [];
  private calls = 0;

  public constructor(private readonly respond: (request: LLMChatRequest, call: number) => LLMChatResponse) {}

  public async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    this.calls += 1;
    this.requests.push(request);
    return this.respond(request, this.calls);
  }
}

function createRunner(
  provider: FakeToolCallingProvider,
  options: {
    maxToolRounds?: number;
    conversationSession?: ConversationSession;
  } = {}
): AgentToolRunner {
  const modelClient = new ModelClient({
    provider,
    defaultModel: "fake-model",
    maxRetries: 0
  });
  const executor = new ToolExecutor();
  executor.register(echoTool);
  executor.register(getCurrentTimeTool);

  return new AgentToolRunner({
    agent: new TestAgent(modelClient),
    toolExecutor: executor,
    maxToolRounds: options.maxToolRounds,
    conversationSession: options.conversationSession
  });
}

function toolCall(name: string, args: unknown, id = `call-${name}`): ToolCall {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args)
    }
  };
}

describe("AgentToolRunner", () => {
  it("returns immediately when the agent does not request tools", async () => {
    const provider = new FakeToolCallingProvider(() => ({
      content: "No tools needed.",
      raw: {}
    }));
    const runner = createRunner(provider);

    const output = await runner.run({ content: "Answer directly." });

    expect(output.content).toBe("No tools needed.");
    expect(output.steps).toHaveLength(0);
    expect(output.finalMessages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(output.conversationSession).toBeInstanceOf(ConversationSession);
    expect(provider.requests[0].messages.map((message) => message.role)).toEqual(["system", "user"]);
  });

  it("executes a single tool call and continues to a final answer", async () => {
    const provider = new FakeToolCallingProvider((_request, call) => call === 1
      ? {
          content: "",
          toolCalls: [toolCall("echo", { message: "hello" }, "call-1")],
          raw: {}
        }
      : {
          content: "Final answer after tool result.",
          raw: {}
        });
    const runner = createRunner(provider);

    const output = await runner.run({ content: "Use echo.", toolChoice: "required" });

    expect(output.content).toBe("Final answer after tool result.");
    expect(output.steps).toHaveLength(1);
    expect(output.steps[0].toolCalls[0].function.name).toBe("echo");
    expect(output.steps[0].toolResults[0]).toEqual({
      ok: true,
      toolName: "echo",
      result: { message: "hello" }
    });
    expect(provider.requests[0].toolChoice).toBe("required");
    expect(provider.requests[1].toolChoice).toBe("auto");
  });

  it("executes multiple tool calls in one round", async () => {
    const provider = new FakeToolCallingProvider((_request, call) => call === 1
      ? {
          content: "",
          toolCalls: [
            toolCall("echo", { message: "hello" }, "call-1"),
            toolCall("getCurrentTime", {}, "call-2")
          ],
          raw: {}
        }
      : {
          content: "Used both tools.",
          raw: {}
        });
    const runner = createRunner(provider);

    const output = await runner.run({ content: "Use tools." });
    const toolMessages = output.finalMessages.filter((message) => message.role === "tool");

    expect(output.steps).toHaveLength(1);
    expect(output.steps[0].toolResults).toHaveLength(2);
    expect(output.steps[0].toolResults.every((result) => result.ok)).toBe(true);
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages.map((message) => message.toolCallId)).toEqual(["call-1", "call-2"]);
  });

  it("feeds unknown tool errors back as tool messages", async () => {
    const provider = new FakeToolCallingProvider((_request, call) => call === 1
      ? {
          content: "",
          toolCalls: [toolCall("missingTool", {}, "call-missing")],
          raw: {}
        }
      : {
          content: "Tool was unavailable.",
          raw: {}
        });
    const runner = createRunner(provider);

    const output = await runner.run({ content: "Call a missing tool." });
    const toolMessage = output.finalMessages.find((message) => message.role === "tool");

    expect(output.steps[0].toolResults[0].ok).toBe(false);
    expect(output.steps[0].toolResults[0].error).toContain("was not found");
    expect(toolMessage?.toolCallId).toBe("call-missing");
    expect(toolMessage?.content).toContain("\"ok\":false");
    expect(output.metadata?.toolErrors).toEqual([output.steps[0].toolResults[0]]);
  });

  it("feeds invalid JSON argument errors back as tool messages", async () => {
    const provider = new FakeToolCallingProvider((_request, call) => call === 1
      ? {
          content: "",
          toolCalls: [toolCall("echo", "{ invalid json", "call-invalid-json")],
          raw: {}
        }
      : {
          content: "Arguments were invalid.",
          raw: {}
        });
    const runner = createRunner(provider);

    const output = await runner.run({ content: "Call echo with invalid JSON." });
    const toolMessage = output.finalMessages.find((message) => message.role === "tool");

    expect(output.steps[0].toolResults[0].ok).toBe(false);
    expect(output.steps[0].toolResults[0].error).toMatch(/json|expected|unexpected/i);
    expect(toolMessage?.toolCallId).toBe("call-invalid-json");
    expect(toolMessage?.content).toContain("\"ok\":false");
  });

  it("stops when maxToolRounds is reached", async () => {
    const provider = new FakeToolCallingProvider(() => ({
      content: "",
      toolCalls: [toolCall("echo", { message: "again" }, "call-loop")],
      raw: {}
    }));
    const runner = createRunner(provider, { maxToolRounds: 1 });

    const output = await runner.run({ content: "Keep calling tools." });

    expect(output.steps).toHaveLength(1);
    expect(output.metadata?.toolLoopStopped).toBe("max_tool_rounds");
    expect(provider.requests).toHaveLength(2);
  });

  it("keeps DeepSeek-compatible assistant and tool message shape", async () => {
    const provider = new FakeToolCallingProvider((_request, call) => call === 1
      ? {
          content: "",
          reasoning: "Need to call echo.",
          toolCalls: [toolCall("echo", { message: "hello" }, "call-1")],
          raw: { provider: "fake" }
        }
      : {
          content: "Final answer.",
          raw: {}
        });
    const runner = createRunner(provider);

    const output = await runner.run({ content: "Use echo.", thinking: true });
    const assistantToolMessage = output.finalMessages.find(
      (message) => message.role === "assistant" && message.toolCalls?.length
    );
    const toolMessage = output.finalMessages.find((message) => message.role === "tool");

    expect(assistantToolMessage?.toolCalls?.[0].id).toBe("call-1");
    expect(assistantToolMessage?.reasoningContent).toBe("Need to call echo.");
    expect(toolMessage?.toolCallId).toBe("call-1");
    expect(provider.requests[1].messages.some((message) => message.toolCalls?.length)).toBe(true);
    expect(provider.requests[1].messages.some((message) => message.toolCallId === "call-1")).toBe(true);
  });

  it("uses a provided ConversationSession", async () => {
    const provider = new FakeToolCallingProvider(() => ({
      content: "Done.",
      raw: {}
    }));
    const conversationSession = new ConversationSession({ id: "provided-session" });
    conversationSession.append({ role: "assistant", content: "Earlier context." });
    const runner = createRunner(provider, { conversationSession });

    const output = await runner.run({ content: "Continue." });

    expect(output.conversationSession).toBe(conversationSession);
    expect(output.conversationSession.id).toBe("provided-session");
    expect(output.finalMessages.map((message) => message.content)).toEqual([
      "Earlier context.",
      "Continue.",
      "Done."
    ]);
  });

  it("stores user, assistant, and tool messages in the session", async () => {
    const provider = new FakeToolCallingProvider((_request, call) => call === 1
      ? {
          content: "",
          toolCalls: [toolCall("echo", { message: "hello" }, "call-1")],
          raw: {}
        }
      : {
          content: "Final answer.",
          raw: {}
        });
    const runner = createRunner(provider);

    const output = await runner.run({ content: "Use echo." });

    expect(output.conversationSession.getLLMMessages().map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant"
    ]);
    expect(output.finalMessages).toEqual(output.conversationSession.getLLMMessages());
    expect(output.conversationSession.getLLMMessages().find((message) => message.role === "tool")?.toolCallId).toBe("call-1");
  });

  it("does not duplicate the current user message in model requests", async () => {
    const provider = new FakeToolCallingProvider(() => ({
      content: "Done.",
      raw: {}
    }));
    const runner = createRunner(provider);

    await runner.run({
      messages: [{ role: "assistant", content: "Prior answer." }],
      content: "Current question."
    });

    expect(provider.requests[0].messages).toEqual([
      { role: "system", content: "Use tools when useful." },
      { role: "assistant", content: "Prior answer." },
      { role: "user", content: "Current question." }
    ]);
  });
});
