import type { LLMProvider } from "../core/model/LLMProvider.js";
import type { LLMChatRequest, LLMChatResponse, LLMStreamChunk } from "../core/model/types.js";
import type { ToolCall } from "../core/tool/types.js";

export class MockProvider implements LLMProvider {
  public readonly name = "mock";

  public async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    const lastUserMessage = [...request.messages].reverse().find((message) => message.role === "user");
    const toolCalls = request.tools?.length ? [this.mockToolCall(request.tools[0].function.name)] : undefined;

    return {
      content: request.responseFormat === "json"
        ? JSON.stringify({ provider: this.name, input: lastUserMessage?.content ?? "", model: request.model })
        : `[mock:${request.model}] ${lastUserMessage?.content ?? ""}`,
      reasoning: request.thinking ? "Mock reasoning trace." : undefined,
      toolCalls,
      usage: {
        promptTokens: request.messages.length,
        completionTokens: 1,
        totalTokens: request.messages.length + 1
      },
      raw: {
        provider: this.name,
        request
      }
    };
  }

  public async *stream(request: LLMChatRequest): AsyncIterable<LLMStreamChunk> {
    const response = await this.chat(request);
    yield {
      contentDelta: response.content,
      reasoningDelta: response.reasoning,
      raw: response.raw
    };
  }

  private mockToolCall(toolName: string): ToolCall {
    const args = toolName === "getCurrentTime" ? {} : { message: "mock tool input" };
    return {
      id: "mock-tool-call-1",
      type: "function",
      function: {
        name: toolName,
        arguments: JSON.stringify(args)
      }
    };
  }
}
