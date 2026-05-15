import { describe, expect, it } from "vitest";
import { ContextAssembler } from "../src/core/conversation/ContextAssembler.js";
import { ConversationSession } from "../src/core/conversation/ConversationSession.js";

describe("ContextAssembler", () => {
  it("returns session messages without injections", () => {
    const session = new ConversationSession();
    session.append({ role: "user", content: "hello" });

    const result = new ContextAssembler().assemble({ session });

    expect(result.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(result.injectedMessageIds).toEqual([]);
  });

  it("inserts injections by priority before conversation messages", () => {
    const session = new ConversationSession();
    session.append({ role: "user", content: "hello" });

    const result = new ContextAssembler().assemble({
      session,
      injections: [
        { id: "low", content: "low", priority: 1 },
        { id: "high", role: "user", content: "high", priority: 10 }
      ]
    });

    expect(result.messages).toEqual([
      { role: "user", content: "high" },
      { role: "system", content: "low" },
      { role: "user", content: "hello" }
    ]);
    expect(result.injectedMessageIds).toEqual(["high", "low"]);
  });

  it("returns removed message ids after trimming", () => {
    const session = new ConversationSession();
    session.append({ id: "old", role: "user", content: "x".repeat(80) });
    session.append({ id: "recent", role: "assistant", content: "ok" });

    const result = new ContextAssembler().assemble({
      session,
      trimOptions: { maxApproxTokens: 2, preserveRecentMessages: 1 }
    });

    expect(result.removedMessageIds).toEqual(["old"]);
    expect(result.messages).toEqual([{ role: "assistant", content: "ok" }]);
  });

  it("does not change the session messages", () => {
    const session = new ConversationSession();
    session.append({ role: "user", content: "hello" });

    new ContextAssembler().assemble({
      session,
      injections: [{ id: "ctx", content: "context" }],
      trimOptions: { maxMessages: 1, preserveRecentMessages: 0 }
    });

    expect(session.getLLMMessages()).toEqual([{ role: "user", content: "hello" }]);
  });
});
