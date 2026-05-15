import type { ToolCall, ToolSchema } from "../tool/types.js";

export type LLMRole = "system" | "user" | "assistant" | "tool";

export type LLMMessage = {
  role: LLMRole;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  reasoningContent?: string;
  raw?: unknown;
  metadata?: Record<string, unknown>;
};

export type TokenUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  raw?: unknown;
};

export type LLMChatRequest = {
  model: string;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  tools?: ToolSchema[];
  toolChoice?: "auto" | "none" | "required" | string;
  responseFormat?: "text" | "json";
  thinking?: boolean;
  metadata?: Record<string, unknown>;
};

export type LLMChatResponse = {
  content: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
  raw?: unknown;
};

export type LLMStreamChunk = {
  contentDelta?: string;
  reasoningDelta?: string;
  toolCallsDelta?: unknown;
  raw?: unknown;
};

export type ModelClientConfig = {
  provider: import("./LLMProvider.js").LLMProvider;
  defaultModel: string;
  maxRetries?: number;
  timeoutMs?: number;
  maxMessages?: number;
};

export type ModelClientChatRequest = Omit<Partial<LLMChatRequest>, "messages"> & {
  messages: LLMMessage[];
};
