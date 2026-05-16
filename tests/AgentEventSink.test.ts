import { describe, expect, it } from "vitest";
import {
  CollectingAgentEventSink,
  NoopAgentEventSink,
} from "../src/kernel/events/index.js";

describe("AgentEventSink", () => {
  it("does not throw when emitting to noop sink", () => {
    const sink = new NoopAgentEventSink();

    expect(() => sink.emit({
      type: "kernel.started",
      message: "Starting.",
    })).not.toThrow();
  });

  it("collects events with id and timestamp", () => {
    const sink = new CollectingAgentEventSink();

    sink.emit({
      type: "agent.started",
      requestId: "req-1",
      traceId: "trace-1",
      agentName: "CriticAgent",
      message: "CriticAgent started.",
    });

    const events = sink.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "agent.started",
      requestId: "req-1",
      traceId: "trace-1",
      agentName: "CriticAgent",
      message: "CriticAgent started.",
    });
    expect(events[0]?.id).toMatch(/^evt-/);
    expect(new Date(events[0]?.timestamp ?? "").toString()).not.toBe("Invalid Date");
  });
});
