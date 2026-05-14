import { AgentRuntimeError } from "../core/errors/AgentRuntimeError.js";
import type { LLMChatResponse, TokenUsage } from "../core/model/types.js";
import type { ToolCall } from "../core/tool/types.js";

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export async function parseJsonResponse(response: Response, providerName: string): Promise<unknown> {
  const text = await response.text();
  const body = parseResponseBody(text);

  if (!response.ok) {
    const error = asRecord(body);
    const message = asString(asRecord(error.error).message) ?? response.statusText;
    throw new AgentRuntimeError(`${providerName} request failed (${response.status}): ${message}`, {
      code: "PROVIDER_HTTP_ERROR",
      statusCode: response.status,
      retryable: RETRYABLE_STATUS_CODES.has(response.status),
      cause: body
    });
  }

  return body;
}

function parseResponseBody(text: string): unknown {
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { rawText: text };
  }
}

export function normalizeOpenAIChatResponse(raw: unknown): LLMChatResponse {
  const root = asRecord(raw);
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const firstChoice = asRecord(choices[0]);
  const message = asRecord(firstChoice.message);
  const usageRaw = asRecord(root.usage);
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map(normalizeToolCall)
    : undefined;

  const usage: TokenUsage | undefined = Object.keys(usageRaw).length
    ? {
        promptTokens: asNumber(usageRaw.prompt_tokens),
        completionTokens: asNumber(usageRaw.completion_tokens),
        totalTokens: asNumber(usageRaw.total_tokens),
        raw: usageRaw
      }
    : undefined;

  return {
    content: asString(message.content) ?? "",
    reasoning: asString(message.reasoning_content),
    toolCalls,
    usage,
    raw
  };
}

export function normalizeToolCall(value: unknown): ToolCall {
  const record = asRecord(value);
  const fn = asRecord(record.function);

  return {
    id: asString(record.id),
    type: "function",
    function: {
      name: asString(fn.name) ?? "",
      arguments: asString(fn.arguments) ?? "{}"
    },
    raw: value
  };
}

export function toOpenAIRequestToolCalls(toolCalls: ToolCall[]): Array<{
  id?: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}> {
  return toolCalls.map((toolCall) => ({
    ...(toolCall.id ? { id: toolCall.id } : {}),
    type: "function",
    function: {
      name: toolCall.function.name,
      arguments: toolCall.function.arguments
    }
  }));
}
