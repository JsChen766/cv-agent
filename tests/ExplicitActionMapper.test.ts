import { describe, expect, it } from "vitest";
import { ExplicitActionMapper } from "../src/agent-core/flow/ExplicitActionMapper.js";
import { ProductFlowRouter } from "../src/agent-core/flow/ProductFlowRouter.js";
import type { CopilotActionRequest, CopilotWorkspace } from "../src/copilot/types.js";

describe("ExplicitActionMapper", () => {
  const mapper = new ExplicitActionMapper();

  it("maps supported explicit actions to plan steps", () => {
    const result = mapper.map({
      request: actionRequest("generate_from_jd", { jdText: "React TypeScript role.", targetRole: "Frontend Engineer" }),
      workspace: null,
    });

    expect(result.kind).toBe("step");
    if (result.kind !== "step") return;
    expect(result.step).toMatchObject({
      agentName: "architect",
      toolName: "generate_resume_from_jd",
      arguments: {
        jdText: "React TypeScript role.",
        jdSaved: false,
        targetRole: "Frontend Engineer",
      },
      summary: "Generate resume from JD after confirmation.",
    });
    expect(result.step.arguments?.jdHash).toEqual(expect.any(String));
  });

  it("preserves needs_input semantics for supported actions", () => {
    const result = mapper.map({
      request: actionRequest("accept"),
      workspace: null,
    });

    expect(result).toEqual({
      kind: "needs_input",
      missingInputs: ["variantId"],
      message: "请先选择一个生成版本。",
    });
  });

  it("preserves unsupported action semantics", () => {
    const result = mapper.map({
      request: actionRequest("unknown_action" as CopilotActionRequest["action"]["type"]),
      workspace: null,
    });

    expect(result).toEqual({ kind: "unsupported" });
  });

  it("resolves action context through ProductFlowRouter without changing mapping", () => {
    const router = new ProductFlowRouter();
    const workspace: CopilotWorkspace = {
      id: "ws-1",
      sessionId: "session-1",
      variants: [],
      productGenerationId: "pgen-11111111-1111-4111-8111-111111111111",
      activeVariantId: "pvar-22222222-2222-4222-8222-222222222222",
      resumeId: "pres-33333333-3333-4333-8333-333333333333",
      status: "ready",
      updatedAt: "2026-06-14T00:00:00.000Z",
    };
    const input = {
      request: actionRequest("accept"),
      workspace,
    };

    expect(router.intentForExplicitAction(input)).toEqual({
      kind: "explicit_action",
      actionType: "accept",
    });
    const result = router.mapExplicitAction(input);

    expect(result.kind).toBe("step");
    if (result.kind !== "step") return;
    expect(result.step).toMatchObject({
      agentName: "architect",
      toolName: "accept_generation_variant",
      arguments: {
        generationId: "pgen-11111111-1111-4111-8111-111111111111",
        variantId: "pvar-22222222-2222-4222-8222-222222222222",
        resumeId: "pres-33333333-3333-4333-8333-333333333333",
      },
    });
  });
});

function actionRequest(
  type: CopilotActionRequest["action"]["type"],
  payload?: Record<string, unknown>,
): CopilotActionRequest {
  return {
    sessionId: "session-1",
    action: {
      type,
      payload,
    },
  };
}
