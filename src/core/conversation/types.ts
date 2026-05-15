import type { LLMMessage } from "../model/types.js";

export type ConversationMessage = LLMMessage & {
  id: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

export type AppendConversationMessageInput = LLMMessage & {
  id?: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
};

export type ConversationSessionSnapshot = {
  id: string;
  messages: ConversationMessage[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
};

export type ConversationSessionConfig = {
  id?: string;
  messages?: AppendConversationMessageInput[];
  metadata?: Record<string, unknown>;
};
