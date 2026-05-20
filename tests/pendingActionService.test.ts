import { describe, expect, it } from "vitest";
import { createAgentTools } from "../src/agent-tools/index.js";
import { PendingActionService } from "../src/agent-core/confirmation/PendingActionService.js";
import { AgentTraceRecorder } from "../src/agent-core/runtime/AgentTrace.js";
import { ToolExecutor } from "../src/agent-core/tools/ToolExecutor.js";
import { ToolRegistry } from "../src/agent-core/tools/ToolRegistry.js";
import { createP12Kernel, testContext } from "./p12Helpers.js";

describe("P12 PendingActionService", () => {
  it("creates, confirms, cancels, expires, and denies wrong users", async () => {
    const kernel = await createP12Kernel();
    const registry = new ToolRegistry();
    registry.registerMany(createAgentTools());
    const service = new PendingActionService();
    const tool = registry.get("save_experience_from_text");
    expect(tool).toBeDefined();

    const action = service.create({
      userId: "user-1",
      sessionId: "cs-test",
      tool: tool!,
      toolArguments: { text: "Built WEEX analytics dashboard." },
    });
    expect(action.status).toBe("pending");
    expect(service.get("wrong-user", action.id)).toBeUndefined();

    const result = await service.confirm({
      userId: "user-1",
      id: action.id,
      registry,
      executor: new ToolExecutor(registry, new AgentTraceRecorder()),
      context: testContext(kernel, registry.list()),
    });
    expect(result.action.status).toBe("executed");
    expect(result.result.status).toBe("success");
    expect((await kernel.productServices.experienceService.listExperiences("user-1")).length).toBe(1);

    const cancellable = service.create({ userId: "user-1", sessionId: "cs-test", tool: tool!, toolArguments: { text: "Another" } });
    expect(service.cancel("user-1", cancellable.id).status).toBe("cancelled");

    const expired = service.create({ userId: "user-1", sessionId: "cs-test", tool: tool!, toolArguments: { text: "Expired" } });
    expired.expiresAt = new Date(Date.now() - 1000).toISOString();
    expect(service.get("user-1", expired.id)?.status).toBe("expired");
    await kernel.close();
  });
});
