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
      {
        role: "user",
        content: "high",
        metadata: {
          injectionId: "high",
          isContextInjection: true
        }
      },
      {
        role: "system",
        content: "low",
        metadata: {
          injectionId: "low",
          isContextInjection: true
        }
      },
      { role: "user", content: "hello" }
    ]);
    expect(result.injectedMessageIds).toEqual(["ctx-injection:high", "ctx-injection:low"]);
  });

  it("keeps original injection metadata while prefixing injected message ids", () => {
    const session = new ConversationSession();
    session.append({ role: "user", content: "hello" });

    const result = new ContextAssembler().assemble({
      session,
      injections: [
        {
          id: "retrieval-1",
          content: "context",
          metadata: { source: "retrieval" }
        }
      ]
    });

    expect(result.injectedMessageIds).toEqual(["ctx-injection:retrieval-1"]);
    expect(result.messages[0].metadata).toEqual({
      source: "retrieval",
      injectionId: "retrieval-1",
      isContextInjection: true
    });
  });

  it("does not double-prefix injection ids that are already prefixed", () => {
    const session = new ConversationSession();

    const result = new ContextAssembler().assemble({
      session,
      injections: [{ id: "ctx-injection:retrieval-1", content: "context" }]
    });

    expect(result.injectedMessageIds).toEqual(["ctx-injection:retrieval-1"]);
    expect(result.messages[0].metadata?.injectionId).toBe("ctx-injection:retrieval-1");
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

  it("returns prefixed removed ids for trimmed context injections", () => {
    const session = new ConversationSession();
    session.append({ id: "shared", role: "user", content: "keep recent session message" });

    const result = new ContextAssembler().assemble({
      session,
      injections: [
        { id: "shared", role: "user", content: "trim injected context" }
      ],
      trimOptions: { maxMessages: 1, preserveRecentMessages: 1 }
    });

    expect(result.removedMessageIds).toEqual(["ctx-injection:shared"]);
    expect(result.injectedMessageIds).toEqual([]);
    expect(result.messages).toEqual([{ role: "user", content: "keep recent session message" }]);
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
