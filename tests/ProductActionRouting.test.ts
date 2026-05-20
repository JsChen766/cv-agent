import { describe, expect, it } from "vitest";
import { createKernel } from "../src/api/kernel/createKernel.js";
import { AgentToolRegistry } from "../src/agents/tools/AgentToolRegistry.js";
import type { ProductAction, ProductActionType } from "../src/copilot/types.js";
import { argsForAction, toolForAction } from "../src/agents/runtime/WorkspaceMerger.js";

describe("product action routing", () => {
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

  it("allows ProductAction payload for future nextActions and variant actions", () => {
    const action: ProductAction = {
      id: "generate-from-jd",
      type: "generate_from_jd",
      label: "Generate from JD",
      primary: true,
      payload: { jdId: "jd-1", targetRole: "Frontend Engineer" },
    };

    expect(action.payload).toEqual({ jdId: "jd-1", targetRole: "Frontend Engineer" });
  });

  it("routes new product action types without rejecting them", () => {
    const actions: ProductActionType[] = [
      "generate_from_jd",
      "optimize_resume_item",
      "rewrite_experience",
      "export_resume",
    ];

    expect(actions.map((type) => toolForAction(type))).toEqual([
      "generate_resume_variants",
      "optimize_resume_item",
      "rewrite_experience",
      "export_resume",
    ]);
  });

  it("does not route any supported action type to an unregistered tool", async () => {
    process.env.NODE_ENV = "test";
    process.env.AUTH_MODE = "dev_header";
    process.env.AGENT_PROVIDER = "mock";
    process.env.FRONTDESK_AGENT_MODE = "fake";
    delete process.env.DATABASE_URL;
    const kernel = await createKernel();
    try {
      const registry = new AgentToolRegistry(kernel);
      for (const type of allActionTypes) {
        const toolName = toolForAction(type);
        expect(toolName, type).toBeDefined();
        expect(registry.hasTool(toolName ?? ""), `${type} -> ${toolName}`).toBe(true);
      }
    } finally {
      await kernel.close();
    }
  });

  it("reads generate_from_jd jdId from payload, clientState, then workspace", () => {
    expect(argsForAction(
      { type: "generate_from_jd", payload: { jdId: "payload-jd", targetRole: "Staff Engineer" } },
      { id: "ws-1", sessionId: "s-1", variants: [], status: "ready", jdId: "workspace-jd", updatedAt: "now" },
      { activeJDId: "client-jd" },
    )).toMatchObject({
      jdId: "payload-jd",
      targetRole: "Staff Engineer",
    });

    expect(argsForAction(
      { type: "generate_from_jd", payload: {} },
      { id: "ws-1", sessionId: "s-1", variants: [], status: "ready", jdId: "workspace-jd", updatedAt: "now" },
      { activeJDId: "client-jd" },
    )).toMatchObject({ jdId: "client-jd" });

    expect(argsForAction(
      { type: "generate_from_jd", payload: {} },
      { id: "ws-1", sessionId: "s-1", variants: [], status: "ready", jdId: "workspace-jd", updatedAt: "now" },
    )).toMatchObject({ jdId: "workspace-jd" });
  });

  it("carries active ids and selectedText into optimize_resume_item arguments", () => {
    expect(argsForAction(
      { type: "optimize_resume_item", payload: {} },
      null,
      {
        activeResumeId: "resume-1",
        activeResumeItemId: "item-1",
        selectedText: "Selected bullet",
      },
    )).toMatchObject({
      resumeId: "resume-1",
      resumeItemId: "item-1",
      selectedText: "Selected bullet",
      instruction: "make_more_quantified",
    });
  });

  it("carries active experience id and selectedText into rewrite_experience arguments", () => {
    expect(argsForAction(
      { type: "rewrite_experience", payload: {} },
      null,
      {
        activeExperienceId: "exp-1",
        selectedText: "Selected experience",
      },
    )).toMatchObject({
      experienceId: "exp-1",
      selectedText: "Selected experience",
      instruction: "rewrite_experience",
    });
  });

  it("does not map export_resume to handle_product_action", () => {
    expect(toolForAction("export_resume")).toBe("export_resume");
    expect(toolForAction("export_resume")).not.toBe("handle_product_action");
  });
});
