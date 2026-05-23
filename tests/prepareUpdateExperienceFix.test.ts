import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeReadToolConfirmationResult } from "../src/agent-core/runtime/AgentOrchestrator.js";
import { AgentOrchestrator } from "../src/agent-core/runtime/AgentOrchestrator.js";
import { createTestKernelContext } from "../src/api/context.js";
import { createP12Kernel } from "./p12Helpers.js";
import type { ToolResult } from "../src/agent-core/tools/ToolResult.js";

describe("experience-receiver prompt rules", () => {
  const promptPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/agent-core/prompts/prompts/experience-receiver.md");
  const prompt = readFileSync(promptPath, "utf-8");

  it("directs optimize/rewrite to update_experience, not prepare_update_experience", () => {
    expect(prompt).toContain("优化这条经历");
    expect(prompt).toContain("改写这条经历");
    expect(prompt).toContain("update_experience");
    expect(prompt).toContain("requiresConfirmation = true");
    expect(prompt).toContain("pendingActionId");
  });

  it("reserves prepare_update_experience for preview-only scenarios", () => {
    expect(prompt).toContain("先预览");
    expect(prompt).toContain("先看看改写方向");
    expect(prompt).toContain("不要保存，先给我草稿");
  });

  it("contains example routing optimize to update_experience", () => {
    expect(prompt).toContain("我想优化一下这条经历");
    expect(prompt).toContain('"toolName": "update_experience"');
  });
});

describe("prepareUpdateExperience fix", () => {
  it("sanitizeReadToolConfirmationResult downgrades needs_confirmation from read tools to success", () => {
    const result: ToolResult = {
      status: "success",
      message: "Prepared update preview.",
      data: { before: { id: "1" }, after: { id: "1", content: "new" } },
      actionResult: {
        status: "needs_confirmation",
        actionType: "update_experience",
        preview: { before: { id: "1" }, after: { id: "1", content: "new" } },
      },
    };

    const sanitized = sanitizeReadToolConfirmationResult(result, "prepare_update_experience");

    expect(sanitized.actionResult?.status).toBe("success");
    expect(sanitized.actionResult?.status).not.toBe("needs_confirmation");
    expect(sanitized.visibility).toBe("user_summary");
    expect((sanitized.actionResult as Record<string, unknown>)?.reason).toBe(
      "read_tool_cannot_request_confirmation",
    );
  });

  it("sanitizeReadToolConfirmationResult passes through non-needs_confirmation results unchanged", () => {
    const result: ToolResult = {
      status: "success",
      message: "Listed experiences.",
      data: { count: 3 },
      actionResult: { status: "success", actionType: "list_experiences" },
    };

    const sanitized = sanitizeReadToolConfirmationResult(result, "list_experiences");
    expect(sanitized).toBe(result);
  });

  it("sanitizeReadToolConfirmationResult passes through results without actionResult unchanged", () => {
    const result: ToolResult = {
      status: "success",
      message: "Done.",
    };

    const sanitized = sanitizeReadToolConfirmationResult(result, "some_tool");
    expect(sanitized).toBe(result);
  });
});

describe("orchestrator integration", () => {
  it("read tool result with needs_confirmation does not produce invalidConfirmation user message", async () => {
    const kernel = await createP12Kernel();
    const orchestrator = new AgentOrchestrator({ kernel });
    const ctx = createTestKernelContext({
      user: { id: "user-read-tool" },
      request: { requestId: "req-read-tool", traceId: "trace-read-tool" },
    });

    // "Show my experience library" routes to experience_receiver, which returns list_experiences
    const response = await orchestrator.handleChat(ctx, {
      message: "Show my experience library",
    });

    // The assistant message must NOT contain the invalidConfirmation error
    expect(response.assistantMessage.content).toBeTruthy();
    expect(response.assistantMessage.content).not.toContain("确认操作缺少确认 ID");
    expect(response.assistantMessage.content).not.toContain("missing a confirmation ID");

    // Should have tool results
    expect(response.raw.toolResults).toBeDefined();
    const results = response.raw.toolResults as Array<{ actionResult?: { status?: string } }>;
    const needsConfirmWithoutId = results.some(
      (r) =>
        r.actionResult?.status === "needs_confirmation" &&
        !(r as { pendingActionId?: string }).pendingActionId,
    );
    expect(needsConfirmWithoutId).toBe(false);

    await kernel.close();
  });

  it("optimize experience message routes to update_experience or needs_input, not needs_confirmation without ID", async () => {
    const kernel = await createP12Kernel();
    const orchestrator = new AgentOrchestrator({ kernel });
    const ctx = createTestKernelContext({
      user: { id: "user-optimize" },
      request: { requestId: "req-optimize", traceId: "trace-optimize" },
    });

    const response = await orchestrator.handleChat(ctx, {
      message: "我想优化一下这条经历",
    });

    expect(response.assistantMessage.content).toBeTruthy();
    // Must NOT contain the invalidConfirmation error message
    expect(response.assistantMessage.content).not.toContain("确认操作缺少确认 ID");
    expect(response.assistantMessage.content).not.toContain("missing a confirmation ID");
    expect(response.assistantMessage.content).not.toContain("cannot safely finalize");

    await kernel.close();
  });
});
