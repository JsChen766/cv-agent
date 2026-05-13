import type { LLMChatRequest, LLMChatResponse, LLMStreamChunk } from "./types.js";

export interface LLMProvider {
  name: string;
  chat(request: LLMChatRequest): Promise<LLMChatResponse>;
  stream?(request: LLMChatRequest): AsyncIterable<LLMStreamChunk>;
}
