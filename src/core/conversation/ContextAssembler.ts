import type { LLMMessage } from "../model/types.js";
import type { ConversationSession } from "./ConversationSession.js";
import { TokenBudgetManager, type TokenBudgetTrimOptions } from "./TokenBudgetManager.js";
import type { ConversationMessage } from "./types.js";

export type ContextInjection = {
  id: string;
  role?: "system" | "user";
  content: string;
  priority?: number;
  metadata?: Record<string, unknown>;
};

export type AssembleContextInput = {
  session: ConversationSession;
  injections?: ContextInjection[];
  trimOptions?: TokenBudgetTrimOptions;
};

export type AssembleContextResult = {
  messages: LLMMessage[];
  removedMessageIds: string[];
  injectedMessageIds: string[];
  approxTokens: number;
};

export class ContextAssembler {
  private readonly tokenBudgetManager = new TokenBudgetManager();

  public assemble(input: AssembleContextInput): AssembleContextResult {
    const baseMessages = input.session.getMessages();
    const injectedMessages = this.toInjectedMessages(input.injections ?? []);
    const assembledMessages = [...injectedMessages, ...baseMessages];
    const trimResult = input.trimOptions
      ? this.tokenBudgetManager.trimMessages(assembledMessages, input.trimOptions)
      : {
          messages: assembledMessages,
          removedMessages: [],
          approxTokensAfter: this.tokenBudgetManager.estimateMessagesTokens(assembledMessages)
        };

    return {
      messages: trimResult.messages.map((message) => this.toLLMMessage(message)),
      removedMessageIds: trimResult.removedMessages.map((message) => message.id),
      injectedMessageIds: trimResult.messages
        .filter((message) => message.metadata?.isContextInjection)
        .map((message) => message.id),
      approxTokens: trimResult.approxTokensAfter
    };
  }

  private toInjectedMessages(injections: ContextInjection[]): ConversationMessage[] {
    return [...injections]
      .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))
      .map((injection) => ({
        role: injection.role ?? "system",
        content: injection.content,
        id: this.toInjectionMessageId(injection.id),
        createdAt: new Date().toISOString(),
        metadata: {
          ...injection.metadata,
          injectionId: injection.id,
          isContextInjection: true
        }
      }));
  }

  private toInjectionMessageId(id: string): string {
    return id.startsWith("ctx-injection:") ? id : `ctx-injection:${id}`;
  }

  private toLLMMessage(message: ConversationMessage): LLMMessage {
    const { id: _id, createdAt: _createdAt, metadata, ...llmMessage } = message;

    if (metadata?.isContextInjection) {
      return {
        ...llmMessage,
        metadata
      };
    }

    return llmMessage;
  }
}
