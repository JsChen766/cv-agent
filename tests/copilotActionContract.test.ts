import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKernel } from "../src/api/kernel/createKernel.js";
import type { ApiKernel } from "../src/api/types.js";
import { AgentRuntime } from "../src/agents/runtime/AgentRuntime.js";
import { activityTypeForDecision, argsForAction, toolForAction } from "../src/agents/runtime/WorkspaceMerger.js";
import { AgentToolRegistry } from "../src/agents/tools/AgentToolRegistry.js";
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

  it("maps every ProductActionType to the expected tool", () => {
    expect(allActionTypes.map((type) => [type, toolForAction(type)])).toEqual([
      ["accept", "save_variant_to_resume"],
      ["reject", "record_variant_decision"],
      ["prefer", "record_variant_decision"],
      ["confirm_metric", "record_variant_decision"],
      ["revise_more_conservative", "revise_variant"],
      ["revise_more_quantified", "revise_variant"],
      ["show_evidence", "show_evidence"],
      ["explain_choice", "explain_choice"],
      ["generate_from_jd", "generate_resume_variants"],
      ["optimize_resume_item", "optimize_resume_item"],
      ["rewrite_experience", "rewrite_experience"],
      ["export_resume", "export_resume"],
    ]);
  });

  it("routes every ProductActionType to a registered tool and never to handle_product_action", () => {
    for (const type of allActionTypes) {
      const toolName = toolForAction(type);
      expect(toolName, type).toBeDefined();
      expect(toolName).not.toBe("handle_product_action");
      expect(registry.hasTool(toolName ?? ""), `${type} -> ${toolName}`).toBe(true);
    }
  });

  it("returns undefined for unknown actions", () => {
    expect(toolForAction("unknown")).toBeUndefined();
  });

  it("resolves generate_from_jd jdId from payload, clientState, then workspace", () => {
    const workspace = { id: "ws-1", sessionId: "s-1", variants: [], status: "ready" as const, jdId: "workspace-jd", updatedAt: "now" };
    expect(argsForAction({ type: "generate_from_jd", payload: { jdId: "payload-jd" } }, workspace, { activeJDId: "client-jd" })).toMatchObject({ jdId: "payload-jd" });
    expect(argsForAction({ type: "generate_from_jd", payload: {} }, workspace, { activeJDId: "client-jd" })).toMatchObject({ jdId: "client-jd" });
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

  it("preserves export_resume action arguments", () => {
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
  });

  it("maps new action tools to stable activity types", () => {
    expect(activityTypeForDecision({ mode: "call_tool", assistantMessage: "", toolCalls: [{ toolName: "optimize_resume_item", arguments: {} }], confidence: 1 }, [])).toBe("revision");
    expect(activityTypeForDecision({ mode: "call_tool", assistantMessage: "", toolCalls: [{ toolName: "rewrite_experience", arguments: {} }], confidence: 1 }, [])).toBe("revision");
    expect(activityTypeForDecision({ mode: "call_tool", assistantMessage: "", toolCalls: [{ toolName: "export_resume", arguments: {} }], confidence: 1 }, [])).toBe("decision");
  });
});
