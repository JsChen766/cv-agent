import type { LLMChatRequest, LLMChatResponse, LLMProvider, LLMStreamChunk } from "../agent-core/model/types.js";
import { normalizeOpenAIChatResponse, parseJsonResponse, toOpenAIRequestToolCalls } from "./providerUtils.js";

export type OpenAICompatibleProviderConfig = {
  name: "openai" | "compatible";
  apiKey: string;
  baseURL: string;
};

export class OpenAICompatibleProvider implements LLMProvider {
  public readonly name: "openai" | "compatible";
  private readonly apiKey: string;
  private readonly baseURL: string;

  public constructor(config: OpenAICompatibleProviderConfig) {
    this.name = config.name;
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL.replace(/\/$/, "");
  }

  public async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.toRequestBody({ ...request, stream: false })),
      signal: request.signal,
    });
    return normalizeOpenAIChatResponse(await parseJsonResponse(response, this.name));
  }

  public async *stream(request: LLMChatRequest): AsyncIterable<LLMStreamChunk> {
    const response = await this.chat(request);
    yield { contentDelta: response.content };
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`,
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
      })),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
      ...(request.stream === undefined ? {} : { stream: request.stream }),
      ...(request.tools ? { tools: request.tools } : {}),
      ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
      ...(request.responseFormat === "json" ? { response_format: { type: "json_object" } } : {}),
    };
  }
}
