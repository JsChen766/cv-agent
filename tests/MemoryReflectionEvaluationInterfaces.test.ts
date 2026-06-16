import { describe, expect, it } from "vitest";
import { careerDomain } from "../src/agent-domains/career/index.js";
import { createTestKernelContext } from "../src/api/context.js";
import { NoopEvaluationHook } from "../src/agent-core/evaluation/NoopEvaluationHook.js";
import type { AgentContext } from "../src/agent-core/runtime/AgentContext.js";
import { AgentOrchestrator } from "../src/agent-core/runtime/AgentOrchestrator.js";
import type { MemoryRecord } from "../src/agent-core/memory/MemoryRecord.js";
import { NoopMemoryProvider } from "../src/agent-core/memory/NoopMemoryProvider.js";
import type { LearningEvent } from "../src/agent-core/reflection/LearningEvent.js";
import { LearningEventRecorder } from "../src/agent-core/reflection/LearningEventRecorder.js";
import { LearningEventService } from "../src/agent-core/reflection/LearningEventService.js";
import { NoopReflectionSink } from "../src/agent-core/reflection/NoopReflectionSink.js";
import { createP12Kernel } from "./p12Helpers.js";

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

  it("LearningEventService records tool, pending, critic, and preference events internally", async () => {
    const delivered: LearningEvent[] = [];
    const toolHookCalls: unknown[] = [];
    const service = new LearningEventService({
      recorder: new LearningEventRecorder([{
        id: "recording-sink",
        record: async (event) => {
          delivered.push(event);
        },
      }]),
      evaluationHooks: [{
        id: "tool-hook",
        onToolResult: async (result) => {
          toolHookCalls.push(result);
        },
      }],
      now: () => new Date("2026-06-14T00:00:00.000Z"),
    });
    const context = {
      userId: "user-1",
      sessionId: "session-1",
      turnId: "turn-1",
    } as AgentContext;

    await service.recordToolResult(context, {
      id: "step-1",
      agentName: "architect",
      toolName: "save_experience_from_text",
      arguments: {},
      summary: "Save experience.",
    }, {
      status: "success",
      actionResult: { actionType: "save_experience_from_text", status: "success" },
    });
    await service.recordPendingActionCreated(context, {
      id: "pa-1",
      userId: "user-1",
      sessionId: "session-1",
      turnId: "turn-1",
      toolName: "generate_resume_from_jd",
      toolArguments: {},
      status: "pending",
      title: "Generate resume",
      summary: "Generate resume",
      riskLevel: "high",
      affectedResources: [{ type: "resume" }],
      createdAt: "2026-06-14T00:00:00.000Z",
      expiresAt: "2026-06-14T00:30:00.000Z",
    });
    await service.recordPendingActionConfirmed(context, {
      id: "pa-1",
      userId: "user-1",
      sessionId: "session-1",
      turnId: "turn-1",
      toolName: "generate_resume_from_jd",
      toolArguments: {},
      status: "confirmed",
      title: "Generate resume",
      summary: "Generate resume",
      riskLevel: "high",
      affectedResources: [],
      createdAt: "2026-06-14T00:00:00.000Z",
      expiresAt: "2026-06-14T00:30:00.000Z",
    }, {
      status: "success",
      actionResult: { actionType: "generate_resume_from_jd", status: "success" },
    });
    await service.recordCriticReview(context, {
      status: "pass",
      criticToolResults: [],
      review: {
        verdict: "pass",
        riskLevel: "low",
        unsupportedClaims: [],
        missingEvidence: [],
        suggestedFixes: [],
        userVisibleSummary: "Review passed.",
      },
    });
    await service.recordExplicitAction(context, "prefer", { variantId: "pvar-1" });

    expect(delivered.map((event) => event.type)).toEqual([
      "experience.saved",
      "pending_action.created",
      "pending_action.confirmed",
      "critic.passed",
      "user.preference_signal",
    ]);
    expect(toolHookCalls).toHaveLength(1);
  });

  it("LearningEventService does not surface recorder failures", async () => {
    const service = new LearningEventService({
      recorder: {
        record: async () => {
          throw new Error("recorder unavailable");
        },
      } as unknown as LearningEventRecorder,
    });
    const context = {
      userId: "user-1",
      sessionId: "session-1",
      turnId: "turn-1",
    } as AgentContext;

    await expect(service.recordExplicitAction(context, "reject", { variantId: "pvar-1" })).resolves.toBeUndefined();
  });

  it("does not record explicit action preference signals when action mapping needs input", async () => {
    const kernel = await createP12Kernel();
    const delivered: LearningEvent[] = [];
    const runtime = new AgentOrchestrator({
      kernel,
      domains: [{
        ...careerDomain,
        capabilities: [{
          id: "test.explicit-action-learning",
          reflectionSinks: [{
            id: "recording-sink",
            record: async (event) => {
              delivered.push(event);
            },
          }],
        }],
      }],
    });
    const ctx = createTestKernelContext({ user: { id: "learning-needs-input-user" }, request: { requestId: "learning-needs-input-req", traceId: "learning-needs-input-trace" } });
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("learning-needs-input-user", {});

    try {
      const response = await runtime.handleExplicitAction(ctx, {
        sessionId: session.id,
        action: { type: "accept" },
      });

      expect(response.raw.actionResults?.[0]).toMatchObject({ status: "needs_input", missingInputs: ["variantId"] });
      expect(delivered.map((event) => event.type)).not.toContain("user.preference_signal");
      expect(delivered.map((event) => event.type)).not.toContain("variant.accepted");
    } finally {
      await kernel.close();
    }
  });

  it("records explicit action learning event after action mapping resolves to a step", async () => {
    const kernel = await createP12Kernel();
    const delivered: LearningEvent[] = [];
    const runtime = new AgentOrchestrator({
      kernel,
      domains: [{
        ...careerDomain,
        capabilities: [{
          id: "test.valid-explicit-action-learning",
          reflectionSinks: [{
            id: "recording-sink",
            record: async (event) => {
              delivered.push(event);
            },
          }],
        }],
      }],
    });
    const userId = "learning-valid-user";
    const ctx = createTestKernelContext({ user: { id: userId }, request: { requestId: "learning-valid-req", traceId: "learning-valid-trace" } });
    const session = await kernel.copilotServices.sessionService.getOrCreateSession(userId, {});

    try {
      const generated = await kernel.productServices.generationProductService.generateResumeFromJD({
        userId,
        sessionId: session.id,
        jdText: "Frontend engineer JD",
        targetRole: "Frontend Engineer",
      });
      const variantId = generated.variants[0]!.id;

      const response = await runtime.handleExplicitAction(ctx, {
        sessionId: session.id,
        action: { type: "accept", variantId, payload: { generationId: generated.generation.id } },
      });

      expect(response.raw.pendingActions?.[0]).toMatchObject({ toolName: "accept_generation_variant" });
      expect(delivered.map((event) => event.type)).toContain("user.preference_signal");
    } finally {
      await kernel.close();
    }
  });

  it("does not record explicit action learning event for unsupported actions", async () => {
    const kernel = await createP12Kernel();
    const delivered: LearningEvent[] = [];
    const runtime = new AgentOrchestrator({
      kernel,
      domains: [{
        ...careerDomain,
        capabilities: [{
          id: "test.unsupported-explicit-action-learning",
          reflectionSinks: [{
            id: "recording-sink",
            record: async (event) => {
              delivered.push(event);
            },
          }],
        }],
      }],
    });
    const ctx = createTestKernelContext({ user: { id: "learning-unsupported-user" }, request: { requestId: "learning-unsupported-req", traceId: "learning-unsupported-trace" } });
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("learning-unsupported-user", {});

    try {
      const response = await runtime.handleExplicitAction(ctx, {
        sessionId: session.id,
        action: { type: "unknown_fake_action" as any },
      });

      expect(response.raw.actionResults?.[0]).toMatchObject({ status: "failed", reason: "unsupported_action" });
      expect(delivered).toEqual([]);
    } finally {
      await kernel.close();
    }
  });
});
