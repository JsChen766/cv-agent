import { describe, expect, it } from "vitest";
import { NoopEvaluationHook } from "../src/agent-core/evaluation/NoopEvaluationHook.js";
import type { MemoryRecord } from "../src/agent-core/memory/MemoryRecord.js";
import { NoopMemoryProvider } from "../src/agent-core/memory/NoopMemoryProvider.js";
import type { LearningEvent } from "../src/agent-core/reflection/LearningEvent.js";
import { LearningEventRecorder } from "../src/agent-core/reflection/LearningEventRecorder.js";
import { NoopReflectionSink } from "../src/agent-core/reflection/NoopReflectionSink.js";

describe("memory, reflection, and evaluation internal interfaces", () => {
  it("NoopMemoryProvider retrieves no records and accepts remember without side effects", async () => {
    const provider = new NoopMemoryProvider();
    const record: MemoryRecord = {
      id: "memory-1",
      userId: "user-1",
      type: "preference",
      text: "Prefer concise bullets.",
    };

    expect(provider.id).toBe("core.noop.memory");
    await expect(provider.retrieve({ userId: "user-1", query: "bullets", limit: 3 })).resolves.toEqual([]);
    await expect(provider.remember?.(record)).resolves.toBeUndefined();
  });

  it("LearningEventRecorder delivers events to sinks and captures sink failures", async () => {
    const delivered: LearningEvent[] = [];
    const event: LearningEvent = {
      id: "learn-1",
      type: "critic.needs_revision",
      userId: "user-1",
      sessionId: "session-1",
      source: "critic",
      createdAt: "2026-06-14T00:00:00.000Z",
    };
    const recorder = new LearningEventRecorder([
      {
        id: "recording-sink",
        record: async (value) => {
          delivered.push(value);
        },
      },
      {
        id: "failing-sink",
        record: async () => {
          throw new Error("sink unavailable");
        },
      },
    ]);

    const result = await recorder.record(event);

    expect(delivered).toEqual([event]);
    expect(result).toEqual({
      eventId: "learn-1",
      delivered: ["recording-sink"],
      failed: [{ sinkId: "failing-sink", reason: "sink unavailable" }],
    });
  });

  it("NoopReflectionSink and NoopEvaluationHook complete without persistence or behavior changes", async () => {
    const sink = new NoopReflectionSink();
    const hook = new NoopEvaluationHook();

    await expect(sink.record({
      id: "learn-2",
      type: "generation.completed",
      userId: "user-1",
      createdAt: "2026-06-14T00:00:00.000Z",
    })).resolves.toBeUndefined();
    await expect(hook.beforeRun?.({ userId: "user-1" })).resolves.toBeUndefined();
    await expect(hook.afterRun?.({ userId: "user-1", status: "completed" })).resolves.toBeUndefined();
    await expect(hook.onToolResult?.({ toolName: "list_experiences", status: "success" })).resolves.toBeUndefined();
    await expect(hook.onCriticReview?.({ verdict: "pass", riskLevel: "low" })).resolves.toBeUndefined();
  });
});
