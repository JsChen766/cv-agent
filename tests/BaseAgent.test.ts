import { describe, expect, it } from "vitest";
import { BaseAgent } from "../src/core/agent/BaseAgent.js";
import { ModelClient } from "../src/core/model/ModelClient.js";
import type { LLMProvider } from "../src/core/model/LLMProvider.js";
import type { LLMChatRequest, LLMChatResponse } from "../src/core/model/types.js";
import { echoTool } from "../src/tools/echoTool.js";

class RecordingProvider implements LLMProvider {
  public readonly name = "recording";
  public readonly requests: LLMChatRequest[] = [];

  public async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    this.requests.push(request);
    return {
      content: "Done.",
      reasoning: "reason",
      usage: { promptTokens: request.messages.length, completionTokens: 1, totalTokens: request.messages.length + 1 },
      raw: { provider: this.name }
    };
  }
}

class TestAgent extends BaseAgent {
  public constructor(provider: RecordingProvider) {
    super({
      name: "test-agent",
      role: "Test agent",
      systemPrompt: "System prompt.",
      modelClient: new ModelClient({
        provider,
        defaultModel: "fake-model",
        maxRetries: 0
      }),
      tools: [echoTool],
      defaultResponseFormat: "text"
    });
  }
}

describe("BaseAgent", () => {
  it("runWithMessages uses the provided messages without appending user content", async () => {
    const provider = new RecordingProvider();
    const agent = new TestAgent(provider);

    const output = await agent.runWithMessages(
      [{ role: "assistant", content: "Existing context." }],
      {
        model: "override-model",
        temperature: 0.2,
        maxTokens: 100,
        responseFormat: "json",
        thinking: true,
        toolChoice: "auto",
        metadata: { requestId: "req-1" }
      }
    );

    expect(provider.requests[0].messages).toEqual([
      { role: "system", content: "System prompt." },
      { role: "assistant", content: "Existing context." }
    ]);
    expect(provider.requests[0].model).toBe("override-model");
    expect(provider.requests[0].temperature).toBe(0.2);
    expect(provider.requests[0].maxTokens).toBe(100);
    expect(provider.requests[0].responseFormat).toBe("json");
    expect(provider.requests[0].thinking).toBe(true);
    expect(provider.requests[0].toolChoice).toBe("auto");
    expect(provider.requests[0].metadata).toEqual({
      agentName: "test-agent",
      agentRole: "Test agent",
      requestId: "req-1"
    });
    expect(provider.requests[0].tools?.[0].function.name).toBe("echo");
    expect(output).toEqual({
      content: "Done.",
      reasoning: "reason",
      toolCalls: undefined,
      raw: { provider: "recording" },
      metadata: {
        usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
        providerResponse: { provider: "recording" }
      }
    });
  });

  it("run appends user content after input messages", async () => {
    const provider = new RecordingProvider();
    const agent = new TestAgent(provider);

    await agent.run({
      messages: [{ role: "assistant", content: "Existing context." }],
      content: "Current user content."
    });

    expect(provider.requests[0].messages).toEqual([
      { role: "system", content: "System prompt." },
      { role: "assistant", content: "Existing context." },
      { role: "user", content: "Current user content." }
    ]);
  });

  it("run preserves skipAppendingUserContent compatibility", async () => {
    const provider = new RecordingProvider();
    const agent = new TestAgent(provider);

    await agent.run({
      messages: [{ role: "user", content: "Already assembled user content." }],
      content: "Do not append this.",
      skipAppendingUserContent: true
    });

    expect(provider.requests[0].messages).toEqual([
      { role: "system", content: "System prompt." },
      { role: "user", content: "Already assembled user content." }
    ]);
  });
});
