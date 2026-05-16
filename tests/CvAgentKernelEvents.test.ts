import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKernel } from "../src/api/kernel/createKernel.js";
import {
  CollectingAgentEventSink,
  createTestKernelContext,
} from "../src/kernel/index.js";
import type { ApiKernel } from "../src/api/types.js";

describe("CvAgentKernel events", () => {
  let originalDatabaseUrl: string | undefined;
  let originalAgentProvider: string | undefined;
  let originalFrontDeskAgentMode: string | undefined;
  let kernel: ApiKernel;

  beforeEach(async () => {
    originalDatabaseUrl = process.env.DATABASE_URL;
    originalAgentProvider = process.env.AGENT_PROVIDER;
    originalFrontDeskAgentMode = process.env.FRONTDESK_AGENT_MODE;
    delete process.env.DATABASE_URL;
    process.env.AGENT_PROVIDER = "mock";
    process.env.FRONTDESK_AGENT_MODE = "mock";
    kernel = await createKernel();
  });

  afterEach(async () => {
    await kernel.close();
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    if (originalAgentProvider === undefined) {
      delete process.env.AGENT_PROVIDER;
    } else {
      process.env.AGENT_PROVIDER = originalAgentProvider;
    }
    if (originalFrontDeskAgentMode === undefined) {
      delete process.env.FRONTDESK_AGENT_MODE;
    } else {
      process.env.FRONTDESK_AGENT_MODE = originalFrontDeskAgentMode;
    }
  });

  it("emits generation progress and decision-required events", async () => {
    const events = new CollectingAgentEventSink();
    const ctx = createTestKernelContext({
      user: { id: "event-user" },
      request: {
        requestId: "req-events",
        traceId: "trace-events",
        source: "test",
      },
      events,
    });

    const result = await kernel.cvAgentKernel.generations.create(ctx, {
      jdText: "React TypeScript role.",
      targetRole: "Frontend Engineer",
    });

    const eventTypes = events.getEvents().map((event) => event.type);
    expect(result.artifacts.length).toBeGreaterThan(0);
    expect(eventTypes).toContain("kernel.started");
    expect(eventTypes).toContain("artifact.candidate.created");
    expect(eventTypes).toContain("artifact.critique.completed");
    expect(eventTypes).toContain("decision.required");
    expect(eventTypes).toContain("kernel.completed");

    const candidateEvent = events.getEvents().find((event) => event.type === "artifact.candidate.created");
    expect(candidateEvent?.data).toBeDefined();
    const artifacts = readArtifacts(candidateEvent?.data);
    expect(artifacts.length).toBeGreaterThan(0);
    expect(typeof artifacts[0]?.id).toBe("string");
    expect(typeof artifacts[0]?.status).toBe("string");
    expect(typeof artifacts[0]?.shortPreview).toBe("string");
    expect((artifacts[0]?.shortPreview as string).length).toBeLessThanOrEqual(120);
  });
});

function readArtifacts(data: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  const artifacts = data?.artifacts;
  if (!Array.isArray(artifacts)) {
    return [];
  }
  return artifacts.filter((item): item is Record<string, unknown> =>
    typeof item === "object" && item !== null && !Array.isArray(item)
  );
}
