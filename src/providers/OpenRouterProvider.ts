import type { LLMProvider } from "../core/model/LLMProvider.js";
import type { LLMChatRequest, LLMChatResponse, LLMStreamChunk } from "../core/model/types.js";
import { AgentRuntimeError } from "../core/errors/AgentRuntimeError.js";
import { normalizeOpenAIChatResponse, parseJsonResponse, toOpenAIRequestToolCalls } from "./providerUtils.js";

export type OpenRouterProviderConfig = {
  apiKey: string;
  baseURL?: string;
  appName?: string;
  siteURL?: string;
};

export class OpenRouterProvider implements LLMProvider {
  public readonly name = "openrouter";
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly appName?: string;
  private readonly siteURL?: string;

  public constructor(config: OpenRouterProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? "https://openrouter.ai/api/v1";
    this.appName = config.appName;
    this.siteURL = config.siteURL;
  }

  public async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.toRequestBody({ ...request, stream: false }))
    });

    return normalizeOpenAIChatResponse(await parseJsonResponse(response, this.name));
  }

  public async *stream(_request: LLMChatRequest): AsyncIterable<LLMStreamChunk> {
    throw new AgentRuntimeError("OpenRouterProvider streaming is not implemented yet.", {
      code: "STREAM_NOT_IMPLEMENTED"
    });
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`,
      ...(this.siteURL ? { "HTTP-Referer": this.siteURL } : {}),
      ...(this.appName ? { "X-Title": this.appName } : {})
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
        ...(message.toolCalls ? { tool_calls: toOpenAIRequestToolCalls(message.toolCalls) } : {})
      })),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
      ...(request.stream === undefined ? {} : { stream: request.stream }),
      ...(request.tools ? { tools: request.tools } : {}),
      ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
      ...(request.responseFormat === "json" ? { response_format: { type: "json_object" } } : {})
    };
  }
}
