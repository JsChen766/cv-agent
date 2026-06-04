import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAgentTools } from "../src/agent-tools/index.js";
import { InMemoryPendingActionRepository } from "../src/agent-core/confirmation/InMemoryPendingActionRepository.js";
import { PendingActionService } from "../src/agent-core/confirmation/PendingActionService.js";
import type { PendingAction } from "../src/agent-core/confirmation/PendingAction.js";
import type { ToolDefinition } from "../src/agent-core/tools/Tool.js";
import { AgentTraceRecorder } from "../src/agent-core/runtime/AgentTrace.js";
import { ToolExecutor } from "../src/agent-core/tools/ToolExecutor.js";
import { ToolRegistry } from "../src/agent-core/tools/ToolRegistry.js";
import { createP12Kernel, testContext } from "./p12Helpers.js";

function pending(overrides: Partial<PendingAction> = {}): PendingAction {
  const now = new Date().toISOString();
  return {
    id: "pa-test",
    userId: "user-1",
    sessionId: "cs-test",
    toolName: "save_experience_from_text",
    toolArguments: { text: "Built analytics dashboard." },
    status: "pending",
    title: "Save experience",
    summary: "Confirm save",
    riskLevel: "medium",
    affectedResources: [{ type: "experience" }],
    createdAt: now,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

describe("P12.2 PendingActionRepository", () => {
  it("creates, gets, lists, and updates in memory", async () => {
    const repo = new InMemoryPendingActionRepository();
    const created = await repo.create(pending());
    expect(await repo.getById("user-1", created.id)).toMatchObject({ id: created.id });
    expect(await repo.getById("wrong-user", created.id)).toBeUndefined();
    expect(await repo.list("user-1", "cs-test")).toHaveLength(1);
    expect((await repo.update({ ...created, status: "cancelled" })).status).toBe("cancelled");
  });

  it("updates status only when the current status matches", async () => {
    const repo = new InMemoryPendingActionRepository();
    const created = await repo.create(pending());
    const confirmed = await repo.updateStatusIfCurrent("user-1", created.id, "pending", { status: "confirmed" });
    expect(confirmed?.status).toBe("confirmed");
    const second = await repo.updateStatusIfCurrent("user-1", created.id, "pending", { status: "executed" });
    expect(second).toBeUndefined();
    expect((await repo.getById("user-1", created.id))?.status).toBe("confirmed");
  });

  it("supports service create/list/get/cancel/confirm and denies invalid confirmation", async () => {
    const kernel = await createP12Kernel();
    const registry = new ToolRegistry();
    registry.registerMany(createAgentTools());
    const tool = registry.get("save_experience_from_text")!;
    const service = new PendingActionService(new InMemoryPendingActionRepository());
    const action = await service.create({
      userId: "user-1",
      sessionId: "cs-test",
      tool,
      toolArguments: { text: "Built analytics dashboard." },
    });

    expect(await service.list("user-1", "cs-test")).toHaveLength(1);
    expect(await service.get("user-1", action.id)).toMatchObject({ id: action.id });
    await expect(service.confirm({
      userId: "wrong-user",
      id: action.id,
      registry,
      executor: new ToolExecutor(registry, new AgentTraceRecorder()),
      context: testContext(kernel, registry.list()),
    })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

    const expired = await service.create({
      userId: "user-1",
      sessionId: "cs-test",
      tool,
      toolArguments: { text: "Expired" },
    });
    expired.expiresAt = new Date(Date.now() - 1000).toISOString();
    await expect(service.confirm({
      userId: "user-1",
      id: expired.id,
      registry,
      executor: new ToolExecutor(registry, new AgentTraceRecorder()),
      context: testContext(kernel, registry.list()),
    })).rejects.toMatchObject({ code: "CONFIRMATION_EXPIRED" });

    const confirmed = await service.confirm({
      userId: "user-1",
      id: action.id,
      registry,
      executor: new ToolExecutor(registry, new AgentTraceRecorder()),
      context: testContext(kernel, registry.list()),
    });
    expect(confirmed.action.status).toBe("executed");

    const cancellable = await service.create({ userId: "user-1", sessionId: "cs-test", tool, toolArguments: { text: "Cancel" } });
    expect((await service.cancel("user-1", cancellable.id)).status).toBe("cancelled");
    await kernel.close();
  });

  it("executes a concurrently confirmed pending action only once", async () => {
    const kernel = await createP12Kernel();
    const registry = new ToolRegistry();
    let executeCount = 0;
    const tool: ToolDefinition = {
      name: "test_confirm_once",
      description: "Test confirm once.",
      ownerAgent: "architect",
      inputSchema: z.object({}),
      outputSchema: z.object({ status: z.enum(["success", "needs_input", "failed"]) }).passthrough(),
      mutability: "write",
      requiresConfirmation: true,
      riskLevel: "medium",
      execute: async () => {
        executeCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { status: "success", message: "done", visibility: "user_summary" };
      },
    };
    registry.register(tool);
    const service = new PendingActionService(new InMemoryPendingActionRepository());
    const action = await service.create({
      userId: "user-1",
      sessionId: "cs-test",
      tool,
      toolArguments: {},
    });
    const executor = new ToolExecutor(registry, new AgentTraceRecorder());
    const context = testContext(kernel, registry.list());
    const results = await Promise.all([
      service.confirm({ userId: "user-1", id: action.id, registry, executor, context }),
      service.confirm({ userId: "user-1", id: action.id, registry, executor, context }),
    ]);
    expect(executeCount).toBe(1);
    expect(results.some((result) => result.result.status === "success")).toBe(true);
    expect(["confirmed", "executed"]).toContain((await service.get("user-1", action.id))?.status);
    await kernel.close();
  });
});
