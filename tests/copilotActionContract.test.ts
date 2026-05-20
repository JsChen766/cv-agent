import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKernel } from "../src/api/kernel/createKernel.js";
import type { ApiKernel } from "../src/api/types.js";
import { AgentRuntime } from "../src/agents/runtime/AgentRuntime.js";
import { activityTypeForDecision, argsForAction, toolForAction } from "../src/agents/runtime/WorkspaceMerger.js";
import { AgentToolRegistry } from "../src/agents/tools/AgentToolRegistry.js";
import type { AgentToolExecutionContext } from "../src/agents/tools/AgentToolTypes.js";
import type { ProductAction, ProductActionType } from "../src/copilot/types.js";
import { createTestKernelContext } from "../src/kernel/context.js";

const allActionTypes: ProductActionType[] = [
  "accept",
  "reject",
  "prefer",
  "confirm_metric",
  "revise_more_conservative",
  "revise_more_quantified",
  "show_evidence",
  "explain_choice",
  "generate_from_jd",
  "optimize_resume_item",
  "rewrite_experience",
  "export_resume",
];

describe("copilot action contract", () => {
  let kernel: ApiKernel;
  let registry: AgentToolRegistry;

  beforeEach(async () => {
    process.env.NODE_ENV = "test";
    process.env.AUTH_MODE = "dev_header";
    process.env.AGENT_PROVIDER = "mock";
    process.env.FRONTDESK_AGENT_MODE = "mock";
    process.env.EXPERIENCE_EXTRACTOR_MODE = "deterministic";
    process.env.ARTIFACT_GENERATOR_MODE = "deterministic";
    process.env.CRITIC_AGENT_MODE = "deterministic";
    process.env.REVISION_AGENT_MODE = "deterministic";
    delete process.env.DATABASE_URL;
    kernel = await createKernel();
    registry = new AgentToolRegistry(kernel);
  });

  afterEach(async () => {
    await kernel.close();
  });

  it("allows ProductAction payload", () => {
    const action: ProductAction = {
      id: "export-current-resume",
      type: "export_resume",
      label: "Export",
      primary: true,
      payload: { resumeId: "pres-1", format: "html" },
    };

    expect(action.payload).toEqual({ resumeId: "pres-1", format: "html" });
  });

  it("routes every ProductActionType to a registered tool and never to handle_product_action", () => {
    for (const type of allActionTypes) {
      const toolName = toolForAction(type);
      expect(toolName, type).toBeDefined();
      expect(toolName).not.toBe("handle_product_action");
      expect(registry.hasTool(toolName ?? ""), `${type} -> ${toolName}`).toBe(true);
    }
  });

  it("resolves generate_from_jd jdId from payload, clientState, then workspace", () => {
    const workspace = { id: "ws-1", sessionId: "s-1", variants: [], status: "ready" as const, jdId: "workspace-jd", updatedAt: "now" };
    expect(argsForAction(
      { type: "generate_from_jd", payload: { jdId: "payload-jd" } },
      workspace,
      { activeJDId: "client-jd" },
    )).toMatchObject({ jdId: "payload-jd" });
    expect(argsForAction(
      { type: "generate_from_jd", payload: {} },
      workspace,
      { activeJDId: "client-jd" },
    )).toMatchObject({ jdId: "client-jd" });
    expect(argsForAction({ type: "generate_from_jd", payload: {} }, workspace)).toMatchObject({ jdId: "workspace-jd" });
  });

  it("preserves optimize_resume_item action arguments", () => {
    expect(argsForAction({
      type: "optimize_resume_item",
      payload: {
        resumeId: "pres-1",
        resumeItemId: "presitem-1",
        selectedText: "Built React systems.",
        instruction: "custom",
      },
    }, null)).toMatchObject({
      resumeId: "pres-1",
      resumeItemId: "presitem-1",
      selectedText: "Built React systems.",
      instruction: "custom",
    });
  });

  it("preserves rewrite_experience action arguments", () => {
    expect(argsForAction({
      type: "rewrite_experience",
      payload: {
        experienceId: "pexp-1",
        selectedText: "Led frontend migration.",
        instruction: "make_more_conservative",
      },
    }, null)).toMatchObject({
      experienceId: "pexp-1",
      selectedText: "Led frontend migration.",
      instruction: "make_more_conservative",
    });
  });

  it("preserves export_resume action arguments and routes to export_resume", () => {
    expect(argsForAction({
      type: "export_resume",
      payload: {
        resumeId: "pres-1",
        format: "pdf",
        templateId: "default",
      },
    }, null)).toMatchObject({
      resumeId: "pres-1",
      format: "pdf",
      templateId: "default",
    });
    expect(toolForAction("export_resume")).toBe("export_resume");
  });

  it("handles unknown action types without an unhandled exception", async () => {
    const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});
    const runtime = new AgentRuntime({ kernel });

    await expect(runtime.handleAction(createTestKernelContext({ user: { id: "user-1" } }), {
      sessionId: session.id,
      action: { type: "unknown" as ProductActionType },
    })).resolves.toMatchObject({
      assistantMessage: { content: "I cannot safely perform that action yet." },
    });
    expect(toolForAction("unknown")).toBeUndefined();
  });

  it("maps new action tools to stable activity types", () => {
    expect(activityTypeForDecision({ mode: "call_tool", assistantMessage: "", toolCalls: [{ toolName: "optimize_resume_item", arguments: {} }], confidence: 1 }, [])).toBe("revision");
    expect(activityTypeForDecision({ mode: "call_tool", assistantMessage: "", toolCalls: [{ toolName: "rewrite_experience", arguments: {} }], confidence: 1 }, [])).toBe("revision");
    expect(activityTypeForDecision({ mode: "call_tool", assistantMessage: "", toolCalls: [{ toolName: "export_resume", arguments: {} }], confidence: 1 }, [])).toBe("decision");
  });

  it("export_resume returns needs_input when resumeId is missing", async () => {
    const result = await registry.execute("export_resume", {}, await toolContext(kernel));
    expect(result).toMatchObject({
      status: "needs_input",
      assistantMessage: "Please choose a resume before exporting.",
    });
  });

  it("export_resume returns structured export and job data on success", async () => {
    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "Frontend draft" });
    const result = await registry.execute("export_resume", { resumeId: resume.id, format: "html", templateId: "default" }, await toolContext(kernel));

    expect(result.status).toBe("success");
    expect(result.timelineItems?.[0]).toMatchObject({
      title: "Resume export created",
      status: "completed",
      relatedExportId: expect.stringMatching(/^export-/),
    });
    expect(result.workspacePatch).toMatchObject({
      resumeId: resume.id,
      activeExportId: expect.stringMatching(/^export-/),
      exportRecords: [expect.objectContaining({ resumeId: resume.id, format: "html", status: "pending" })],
    });
    expect(result.raw).toMatchObject({
      exportId: expect.stringMatching(/^export-/),
      jobId: expect.stringMatching(/^job-/),
      resumeId: resume.id,
      format: "html",
    });
    expect(result.rawIds?.decisionIds?.length).toBe(2);
  });

  it("optimize_resume_item returns needs_input when no text can be resolved", async () => {
    const result = await registry.execute("optimize_resume_item", {}, await toolContext(kernel));
    expect(result.status).toBe("needs_input");
    expect(result.assistantMessage).toContain("select a resume item or text");
  });

  it("optimize_resume_item returns success when selectedText is present", async () => {
    const result = await registry.execute("optimize_resume_item", {
      selectedText: "Built React systems for internal users.",
      instruction: "make_more_quantified",
    }, await toolContext(kernel));
    expect(result.status).toBe("success");
    expect(result.assistantMessage).toContain("已生成简历条目优化建议");
    expect(result.timelineItems?.[0]?.type).toBe("revision_completed");
  });

  it("rewrite_experience returns needs_input when no text can be resolved", async () => {
    const result = await registry.execute("rewrite_experience", {}, await toolContext(kernel));
    expect(result.status).toBe("needs_input");
    expect(result.assistantMessage).toContain("select an experience or text");
  });

  it("rewrite_experience returns success from selectedText or experienceId", async () => {
    const byText = await registry.execute("rewrite_experience", {
      selectedText: "Led frontend migration from legacy stack.",
      instruction: "make_more_conservative",
    }, await toolContext(kernel));
    expect(byText.status).toBe("success");
    expect(byText.timelineItems?.[0]?.type).toBe("revision_completed");

    const created = await kernel.productServices.experienceService.createExperience("user-1", {
      title: "Frontend migration",
      content: "Migrated legacy frontend modules to React.",
    });
    const byExperience = await registry.execute("rewrite_experience", {
      experienceId: created.experience.id,
    }, await toolContext(kernel));
    expect(byExperience.status).toBe("success");
    expect(byExperience.rawIds?.decisionIds).toContain(created.experience.id);
  });
});

async function toolContext(kernel: ApiKernel): Promise<AgentToolExecutionContext> {
  const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});
  return {
    ctx: createTestKernelContext({ user: { id: "user-1" } }),
    session,
    workspace: null,
    request: { sessionId: session.id, message: "tool test", clientState: {} },
    turnId: "turn-test",
  };
}
