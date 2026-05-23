import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AgentOrchestrator } from "../src/agent-core/runtime/AgentOrchestrator.js";
import { CopilotOrchestrator } from "../src/copilot/CopilotOrchestrator.js";
import { createTestKernelContext } from "../src/api/context.js";
import { createP12Kernel } from "./p12Helpers.js";

describe("P12.2 explicit copilot actions", () => {
  it("CopilotOrchestrator.handleAction delegates to handleExplicitAction, not handleChat", async () => {
    const source = await readFile("src/copilot/CopilotOrchestrator.ts", "utf8");
    const handleActionBody = source.slice(source.indexOf("public handleAction"), source.indexOf("public runtimeConfirm"));
    expect(handleActionBody).toContain("handleExplicitAction");
    expect(handleActionBody).not.toContain("handleChat");
  });

  it("executes read action, creates pending for write/export, and fails unsupported actions", async () => {
    const kernel = await createP12Kernel();
    const runtime = new AgentOrchestrator({ kernel });
    const facade = new CopilotOrchestrator({ kernel });
    const ctx = createTestKernelContext({ user: { id: "user-1" }, request: { requestId: "req-1", traceId: "trace-1" } });
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});

    const read = await runtime.handleExplicitAction(ctx, {
      sessionId: session.id,
      action: { type: "show_evidence", variantId: "artifact-1" },
    });
    expect(read.raw.actionResults?.[0]).toMatchObject({ status: "needs_input", actionType: "show_evidence" });
    expect(JSON.stringify(read.raw.agentTrace)).toContain("show_evidence");

    const write = await runtime.handleExplicitAction(ctx, {
      sessionId: session.id,
      action: { type: "generate_from_jd", payload: { jdText: "React TypeScript role." } },
    });
    expect(write.raw.pendingActions?.[0]).toMatchObject({ toolName: "generate_resume_from_jd" });
    expect(write.raw.actionResults?.[0]?.status).toBe("needs_confirmation");

    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "Demo resume" });
    const exported = await facade.handleAction(ctx, {
      sessionId: session.id,
      action: { type: "export_resume" },
      clientState: { activeResumeId: resume.id },
    });
    expect(exported.raw.pendingActions?.[0]).toMatchObject({ toolName: "export_resume" });

    // needs_input for missing variantId on a supported action
    const needsInput = await runtime.handleExplicitAction(ctx, {
      sessionId: session.id,
      action: { type: "accept" },
    });
    expect(needsInput.raw.actionResults?.[0]).toMatchObject({ status: "needs_input", missingInputs: ["variantId"] });

    // truly unsupported action type
    const unsupported = await runtime.handleExplicitAction(ctx, {
      sessionId: session.id,
      action: { type: "unknown_fake_action" as any },
    });
    expect(unsupported.raw.actionResults?.[0]).toMatchObject({ status: "failed", reason: "unsupported_action" });
    await kernel.close();
  });
});
