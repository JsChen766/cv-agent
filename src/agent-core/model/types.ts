export type LLMRole = "system" | "user" | "assistant" | "tool";

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
  raw?: unknown;
};

export type LLMMessage = {
  role: LLMRole;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  reasoningContent?: string;
  metadata?: Record<string, unknown>;
};

export type LLMChatRequest = {
  model: string;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  tools?: unknown[];
  toolChoice?: unknown;
  responseFormat?: "json" | "text";
  thinking?: boolean;
  metadata?: Record<string, unknown>;
};

export type ModelClientChatRequest = Omit<LLMChatRequest, "model"> & {
  model?: string;
};

export type LLMUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type LLMChatResponse = {
  content: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  usage?: LLMUsage;
  raw?: unknown;
};

export type LLMStreamChunk = {
  contentDelta?: string;
  reasoningDelta?: string;
  toolCallsDelta?: unknown;
  raw?: unknown;
};

export type ModelClientConfig = {
  provider: LLMProvider;
  defaultModel: string;
  maxRetries?: number;
  timeoutMs?: number;
  maxMessages?: number;
};

export interface LLMProvider {
  name: string;
  chat(request: LLMChatRequest): Promise<LLMChatResponse>;
  stream?(request: LLMChatRequest): AsyncIterable<LLMStreamChunk>;
}
