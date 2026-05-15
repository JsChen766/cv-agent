import { describe, expect, it } from "vitest";
import { ConversationSession } from "../src/core/conversation/ConversationSession.js";

describe("ConversationSession", () => {
  it("appends messages with generated id and createdAt", () => {
    const session = new ConversationSession({ id: "session-1" });

    const message = session.append({ role: "user", content: "hello" });

    expect(message.id).toMatch(/^message-/);
    expect(message.createdAt).toBeTruthy();
    expect(session.getMessages()).toHaveLength(1);
  });

  it("appends many messages", () => {
    const session = new ConversationSession();

    const messages = session.appendMany([
      { role: "user", content: "one" },
      { role: "assistant", content: "two" }
    ]);

    expect(messages).toHaveLength(2);
    expect(session.getMessages().map((message) => message.content)).toEqual(["one", "two"]);
  });

  it("returns a copy of the message array", () => {
    const session = new ConversationSession();
    session.append({ role: "user", content: "hello" });

    const messages = session.getMessages();
    messages.push({
      id: "external",
      createdAt: new Date().toISOString(),
      role: "assistant",
      content: "external"
    });

    expect(session.getMessages()).toHaveLength(1);
  });

  it("returns LLM messages without conversation fields", () => {
    const session = new ConversationSession();
    session.append({
      id: "message-1",
      createdAt: "2026-05-15T00:00:00.000Z",
      role: "user",
      content: "hello",
      metadata: { source: "test" }
    });

    expect(session.getLLMMessages()).toEqual([{ role: "user", content: "hello" }]);
  });

  it("creates and restores snapshots", () => {
    const session = new ConversationSession({
      id: "session-1",
      metadata: { userId: "u1" },
      messages: [{ id: "message-1", createdAt: "2026-05-15T00:00:00.000Z", role: "user", content: "hello" }]
    });

    const restored = ConversationSession.fromSnapshot(session.snapshot());

    expect(restored.id).toBe("session-1");
    expect(restored.snapshot()).toEqual(session.snapshot());
  });

  it("clears messages and updates updatedAt", async () => {
    const session = new ConversationSession();
    session.append({ role: "user", content: "hello" });
    const before = session.snapshot().updatedAt;

    await new Promise((resolve) => setTimeout(resolve, 2));
    session.clear();

    expect(session.getMessages()).toHaveLength(0);
    expect(session.snapshot().updatedAt).not.toBe(before);
  });
});
