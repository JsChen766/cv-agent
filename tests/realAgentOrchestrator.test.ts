import { describe, expect, it } from "vitest";
import { AgentOrchestrator } from "../src/agent-core/runtime/AgentOrchestrator.js";
import { createTestKernelContext } from "../src/kernel/context.js";
import { createP12Kernel } from "./p12Helpers.js";

describe("P12 real AgentOrchestrator", () => {
  it("lists experiences, creates pending save, confirms save, and creates pending delete", async () => {
    const kernel = await createP12Kernel();
    const orchestrator = new AgentOrchestrator({ kernel });
    const ctx = createTestKernelContext({ user: { id: "user-1" }, request: { requestId: "req-1", traceId: "trace-1" } });

    const list = await orchestrator.handleChat(ctx, { message: "我想查看下我自己的经历库" });
    expect(JSON.stringify(list.raw.agentTrace)).toContain("list_experiences");
    expect(list.assistantMessage.content).toContain("empty");

    const save = await orchestrator.handleChat(ctx, { sessionId: list.sessionId, message: "这是我的经历，帮我保存下：WEEX data analysis dashboard with SQL." });
    expect(save.raw.pendingActions?.length).toBe(1);
    expect(await kernel.productServices.experienceService.listExperiences("user-1")).toHaveLength(0);

    const pendingId = (save.raw.pendingActions![0] as { id: string }).id;
    const confirmed = await orchestrator.confirmPendingAction(ctx, pendingId);
    expect(confirmed.raw.actionResults?.[0]?.status).toBe("success");
    expect(await kernel.productServices.experienceService.listExperiences("user-1")).toHaveLength(1);

    const notEmpty = await orchestrator.handleChat(ctx, { sessionId: list.sessionId, message: "所以我的经历库里面现在还为空吗" });
    expect(notEmpty.assistantMessage.content).toContain("1 item");

    const del = await orchestrator.handleChat(ctx, { sessionId: list.sessionId, message: "删掉 WEEX 那条经历" });
    expect(JSON.stringify(del.raw.agentTrace)).toContain("search_experiences");
    expect(del.raw.pendingActions?.some((item) => (item as { toolName: string }).toolName === "delete_experience")).toBe(true);
    expect(await kernel.productServices.experienceService.listExperiences("user-1")).toHaveLength(1);
    await kernel.close();
  });
});
