import { stableId } from "../../knowledge/keywordUtils.js";
import type { LLMMessage } from "../model/types.js";
import { TokenBudgetManager, type TokenBudgetTrimOptions, type TokenBudgetTrimResult } from "./TokenBudgetManager.js";
import type {
  AppendConversationMessageInput,
  ConversationMessage,
  ConversationSessionConfig,
  ConversationSessionSnapshot
} from "./types.js";

export class ConversationSession {
  private readonly sessionId: string;
  private createdAtValue: string;
  private readonly metadata?: Record<string, unknown>;
  private updatedAtValue: string;
  private messages: ConversationMessage[] = [];

  public constructor(config: ConversationSessionConfig = {}) {
    const now = new Date().toISOString();
    this.sessionId = config.id ?? stableId("conversation", `${now}:${Math.random()}`);
    this.createdAtValue = now;
    this.updatedAtValue = now;
    this.metadata = config.metadata;

    if (config.messages?.length) {
      this.appendMany(config.messages);
    }
  }

  public get id(): string {
    return this.sessionId;
  }

  public append(message: AppendConversationMessageInput): ConversationMessage {
    const createdAt = message.createdAt ?? new Date().toISOString();
    const conversationMessage: ConversationMessage = {
      ...message,
      id: message.id ?? stableId("message", `${this.sessionId}:${createdAt}:${this.messages.length}:${message.role}:${message.content}`),
      createdAt
    };

    this.messages.push(conversationMessage);
    this.touch();
    return conversationMessage;
  }

  public appendMany(messages: AppendConversationMessageInput[]): ConversationMessage[] {
    return messages.map((message) => this.append(message));
  }

  public getMessages(): ConversationMessage[] {
    return [...this.messages];
  }

  public getLLMMessages(): LLMMessage[] {
    return this.messages.map(({ id: _id, createdAt: _createdAt, metadata: _metadata, ...message }) => message);
  }

  public clear(): void {
    this.messages = [];
    this.touch();
  }

  public trim(options: TokenBudgetTrimOptions): TokenBudgetTrimResult {
    const manager = new TokenBudgetManager();
    const result = manager.trimMessages(this.messages, options);
    this.messages = result.messages;

    if (result.removedMessages.length) {
      this.touch();
    }

    return result;
  }

  public snapshot(): ConversationSessionSnapshot {
    return {
      id: this.sessionId,
      messages: [...this.messages],
      createdAt: this.createdAtValue,
      updatedAt: this.updatedAtValue,
      ...(this.metadata ? { metadata: this.metadata } : {})
    };
  }

  public static fromSnapshot(snapshot: ConversationSessionSnapshot): ConversationSession {
    const session = new ConversationSession({
      id: snapshot.id,
      metadata: snapshot.metadata
    });
    session.messages = [...snapshot.messages];
    session.createdAtValue = snapshot.createdAt;
    session.updatedAtValue = snapshot.updatedAt;
    return session;
  }

  private touch(): void {
    this.updatedAtValue = new Date().toISOString();
  }
}
