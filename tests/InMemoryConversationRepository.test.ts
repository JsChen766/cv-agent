import { describe, expect, it } from "vitest";
import { ConversationSession } from "../src/core/conversation/ConversationSession.js";
import { InMemoryConversationRepository } from "../src/core/conversation/InMemoryConversationRepository.js";

describe("InMemoryConversationRepository", () => {
  it("saves and gets a snapshot by id", async () => {
    const repo = new InMemoryConversationRepository();
    const session = new ConversationSession({ id: "session-1" });
    session.append({ role: "user", content: "hello" });

    await repo.save(session.snapshot());

    await expect(repo.getById("session-1")).resolves.toEqual(session.snapshot());
  });

  it("overwrites snapshots with the same id", async () => {
    const repo = new InMemoryConversationRepository();
    const session = new ConversationSession({ id: "session-1" });
    await repo.save(session.snapshot());
    session.append({ role: "assistant", content: "updated" });
    await repo.save(session.snapshot());

    const snapshot = await repo.getById("session-1");

    expect(snapshot?.messages.map((message) => message.content)).toEqual(["updated"]);
  });

  it("returns null for a missing id", async () => {
    const repo = new InMemoryConversationRepository();

    await expect(repo.getById("missing")).resolves.toBeNull();
  });

  it("lists saved ids", async () => {
    const repo = new InMemoryConversationRepository();

    await repo.save(new ConversationSession({ id: "session-1" }).snapshot());
    await repo.save(new ConversationSession({ id: "session-2" }).snapshot());

    await expect(repo.listIds()).resolves.toEqual(["session-1", "session-2"]);
  });
});
