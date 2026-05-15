import type { ConversationMessage } from "./types.js";

export type TokenBudgetTrimOptions = {
  maxMessages?: number;
  maxApproxTokens?: number;
  preserveRecentMessages?: number;
  preserveToolResults?: boolean;
  preserveSystemMessages?: boolean;
};

export type TokenBudgetTrimResult = {
  messages: ConversationMessage[];
  removedMessages: ConversationMessage[];
  approxTokensBefore: number;
  approxTokensAfter: number;
};

export class TokenBudgetManager {
  public estimateMessageTokens(message: Pick<ConversationMessage, "content">): number {
    return Math.ceil(message.content.length / 4);
  }

  public estimateMessagesTokens(messages: Pick<ConversationMessage, "content">[]): number {
    return messages.reduce((total, message) => total + this.estimateMessageTokens(message), 0);
  }

  public trimMessages(
    messages: ConversationMessage[],
    options: TokenBudgetTrimOptions
  ): TokenBudgetTrimResult {
    const approxTokensBefore = this.estimateMessagesTokens(messages);
    const preserveSystemMessages = options.preserveSystemMessages ?? true;
    const preserveRecentMessages = options.preserveRecentMessages ?? 8;
    const preserveToolResults = options.preserveToolResults ?? false;
    let kept = [...messages];
    const removedMessages: ConversationMessage[] = [];

    if (options.maxMessages !== undefined && kept.length > options.maxMessages) {
      kept = this.removeUntil(kept, kept.length - options.maxMessages, {
        removedMessages,
        preserveSystemMessages,
        preserveRecentMessages,
        preserveToolResults
      });
    }

    if (options.maxApproxTokens !== undefined) {
      while (this.estimateMessagesTokens(kept) > options.maxApproxTokens) {
        const next = this.chooseRemovalCandidateIndex(kept, {
          preserveSystemMessages,
          preserveRecentMessages,
          preserveToolResults
        });

        if (next === -1) {
          break;
        }

        const [removed] = kept.splice(next, 1);
        removedMessages.push(removed);
      }
    }

    return {
      messages: kept,
      removedMessages,
      approxTokensBefore,
      approxTokensAfter: this.estimateMessagesTokens(kept)
    };
  }

  private removeUntil(
    messages: ConversationMessage[],
    removeCount: number,
    options: {
      removedMessages: ConversationMessage[];
      preserveSystemMessages: boolean;
      preserveRecentMessages: number;
      preserveToolResults: boolean;
    }
  ): ConversationMessage[] {
    const kept = [...messages];

    while (removeCount > 0) {
      const next = this.chooseRemovalCandidateIndex(kept, options);

      if (next === -1) {
        break;
      }

      const [removed] = kept.splice(next, 1);
      options.removedMessages.push(removed);
      removeCount -= 1;
    }

    return kept;
  }

  private chooseRemovalCandidateIndex(
    messages: ConversationMessage[],
    options: {
      preserveSystemMessages: boolean;
      preserveRecentMessages: number;
      preserveToolResults: boolean;
    }
  ): number {
    const recentStart = Math.max(0, messages.length - options.preserveRecentMessages);
    const removable = messages
      .map((message, index) => ({ message, index }))
      .filter(({ message, index }) => {
        if (options.preserveSystemMessages && message.role === "system") {
          return false;
        }

        if (index >= recentStart && (message.role !== "tool" || options.preserveToolResults)) {
          return false;
        }

        return true;
      });

    if (removable.length === 0) {
      return -1;
    }

    removable.sort((left, right) => {
      const leftToolPriority = left.message.role === "tool" && !options.preserveToolResults ? 0 : 1;
      const rightToolPriority = right.message.role === "tool" && !options.preserveToolResults ? 0 : 1;

      if (leftToolPriority !== rightToolPriority) {
        return leftToolPriority - rightToolPriority;
      }

      if (options.preserveToolResults && left.message.role !== right.message.role) {
        if (left.message.role === "tool") {
          return 1;
        }
        if (right.message.role === "tool") {
          return -1;
        }
      }

      return left.index - right.index;
    });

    return removable[0].index;
  }
}
