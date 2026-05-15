import type { LLMMessage } from "../model/types.js";
import type { ToolCall } from "../tool/types.js";

export type AgentInput = {
  content: string;
  messages?: LLMMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "text" | "json";
  thinking?: boolean;
  toolChoice?: "auto" | "none" | "required" | string;
  metadata?: Record<string, unknown>;
  skipAppendingUserContent?: boolean;
};

export type AgentOutput = {
  content: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  raw?: unknown;
  metadata?: Record<string, unknown>;
};

export type BaseAgentConfig = {
  name: string;
  role: string;
  systemPrompt: string;
  modelClient: import("../model/ModelClient.js").ModelClient;
  tools?: import("../tool/types.js").ToolDefinition[];
  defaultResponseFormat?: "text" | "json";
};
