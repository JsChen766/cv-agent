import type { LLMChatRequest, LLMChatResponse, LLMProvider, LLMStreamChunk } from "../agent-core/model/types.js";
import { asRecord, asString, normalizeOpenAIChatResponse, parseJsonResponse, toOpenAIRequestToolCalls } from "./providerUtils.js";

export type DeepSeekProviderConfig = {
  apiKey: string;
  baseURL?: string;
};

export class DeepSeekProvider implements LLMProvider {
  public readonly name = "deepseek";
  private readonly apiKey: string;
  private readonly baseURL: string;

  public constructor(config: DeepSeekProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? "https://api.deepseek.com";
  }

  public async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.toRequestBody({ ...request, stream: false }))
    });

    return normalizeOpenAIChatResponse(await parseJsonResponse(response, this.name));
  }

  public async *stream(request: LLMChatRequest): AsyncIterable<LLMStreamChunk> {
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.toRequestBody({ ...request, stream: true }))
    });

    if (!response.ok || !response.body) {
      await parseJsonResponse(response, this.name);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const chunk = this.parseSseLine(line);
        if (chunk) {
          yield chunk;
        }
      }
    }
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`
    };
  }

  private toRequestBody(request: LLMChatRequest): Record<string, unknown> {
    return {
      model: request.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.name ? { name: message.name } : {}),
        ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
        ...(message.toolCalls ? { tool_calls: toOpenAIRequestToolCalls(message.toolCalls) } : {}),
        ...(message.reasoningContent ? { reasoning_content: message.reasoningContent } : {})
      })),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
      ...(request.stream === undefined ? {} : { stream: request.stream }),
      ...(request.tools ? { tools: request.tools } : {}),
      ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
      ...(request.responseFormat === "json" ? { response_format: { type: "json_object" } } : {}),
      ...(request.thinking === undefined ? {} : { thinking: { type: request.thinking ? "enabled" : "disabled" } })
    };
  }

  private parseSseLine(line: string): LLMStreamChunk | null {
    if (!line.startsWith("data:")) {
      return null;
    }

    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") {
      return null;
    }

    const raw = JSON.parse(data) as unknown;
    const root = asRecord(raw);
    const choices = Array.isArray(root.choices) ? root.choices : [];
    const firstChoice = asRecord(choices[0]);
    const delta = asRecord(firstChoice.delta);

    return {
      contentDelta: asString(delta.content),
      reasoningDelta: asString(delta.reasoning_content),
      toolCallsDelta: delta.tool_calls,
      raw
    };
  }
}
