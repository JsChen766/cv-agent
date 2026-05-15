import { describe, expect, it } from "vitest";
import { TokenBudgetManager } from "../src/core/conversation/TokenBudgetManager.js";
import type { ConversationMessage } from "../src/core/conversation/types.js";

function message(id: string, role: ConversationMessage["role"], content: string): ConversationMessage {
  return {
    id,
    role,
    content,
    createdAt: "2026-05-15T00:00:00.000Z"
  };
}

describe("TokenBudgetManager", () => {
  it("estimates message tokens by content length", () => {
    const manager = new TokenBudgetManager();

    expect(manager.estimateMessageTokens({ content: "123456789" })).toBe(3);
  });

  it("trims by maxMessages", () => {
    const manager = new TokenBudgetManager();
    const messages = [
      message("m1", "user", "one"),
      message("m2", "assistant", "two"),
      message("m3", "user", "three")
    ];

    const result = manager.trimMessages(messages, { maxMessages: 2, preserveRecentMessages: 1 });

    expect(result.messages.map((item) => item.id)).toEqual(["m2", "m3"]);
    expect(result.removedMessages.map((item) => item.id)).toEqual(["m1"]);
  });

  it("trims by maxApproxTokens", () => {
    const manager = new TokenBudgetManager();
    const messages = [
      message("m1", "user", "a".repeat(40)),
      message("m2", "assistant", "short"),
      message("m3", "user", "latest")
    ];

    const result = manager.trimMessages(messages, { maxApproxTokens: 4, preserveRecentMessages: 1 });

    expect(result.messages.map((item) => item.id)).toEqual(["m2", "m3"]);
    expect(result.approxTokensAfter).toBeLessThanOrEqual(4);
  });

  it("preserves system messages by default", () => {
    const manager = new TokenBudgetManager();
    const messages = [
      message("system", "system", "system prompt"),
      message("old", "user", "old"),
      message("recent", "assistant", "recent")
    ];

    const result = manager.trimMessages(messages, { maxMessages: 1, preserveRecentMessages: 0 });

    expect(result.messages.map((item) => item.id)).toContain("system");
  });

  it("preserves recent non-tool messages", () => {
    const manager = new TokenBudgetManager();
    const messages = [
      message("old", "user", "old"),
      message("recent-1", "assistant", "recent one"),
      message("recent-2", "user", "recent two")
    ];

    const result = manager.trimMessages(messages, { maxMessages: 1, preserveRecentMessages: 2 });

    expect(result.messages.map((item) => item.id)).toEqual(["recent-1", "recent-2"]);
  });

  it("removes long tool results by default", () => {
    const manager = new TokenBudgetManager();
    const messages = [
      message("user", "user", "question"),
      message("tool", "tool", "x".repeat(400)),
      message("assistant", "assistant", "answer")
    ];

    const result = manager.trimMessages(messages, { maxApproxTokens: 5, preserveRecentMessages: 2 });

    expect(result.removedMessages.map((item) => item.id)).toContain("tool");
    expect(result.messages.map((item) => item.id)).not.toContain("tool");
  });

  it("keeps tool messages as late removal candidates when preserveToolResults is true", () => {
    const manager = new TokenBudgetManager();
    const messages = [
      message("tool", "tool", "tool result"),
      message("old-user", "user", "old user"),
      message("recent", "assistant", "recent")
    ];

    const result = manager.trimMessages(messages, {
      maxMessages: 2,
      preserveRecentMessages: 1,
      preserveToolResults: true
    });

    expect(result.messages.map((item) => item.id)).toEqual(["tool", "recent"]);
    expect(result.removedMessages.map((item) => item.id)).toEqual(["old-user"]);
  });

  it("does not modify the original array", () => {
    const manager = new TokenBudgetManager();
    const messages = [
      message("m1", "user", "one"),
      message("m2", "assistant", "two")
    ];

    manager.trimMessages(messages, { maxMessages: 1, preserveRecentMessages: 0 });

    expect(messages.map((item) => item.id)).toEqual(["m1", "m2"]);
  });
});
