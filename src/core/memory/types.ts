import type { LLMMessage } from "../model/types.js";

export type MemoryRecord = {
  sessionId: string;
  messages: LLMMessage[];
  updatedAt: string;
};

export type ConversationContextInput = {
  userProfile?: Record<string, unknown>;
  shortTermMemory?: LLMMessage[];
  retrievedKnowledge?: string[];
  taskMetadata?: Record<string, unknown>;
};
