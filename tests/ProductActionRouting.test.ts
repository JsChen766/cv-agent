import { describe, expect, it } from "vitest";
import type { ProductAction } from "../src/copilot/types.js";
import { argsForAction, toolForAction } from "../src/agents/runtime/WorkspaceMerger.js";

describe("product action routing", () => {
  it("routes new product action types without rejecting them", () => {
    const actions: ProductAction["type"][] = [
      "generate_from_jd",
      "optimize_resume_item",
      "rewrite_experience",
      "export_resume",
    ];

    expect(actions.map((type) => toolForAction(type))).toEqual([
      "generate_resume_variants",
      "revise_variant",
      "revise_variant",
      "handle_product_action",
    ]);
  });

  it("carries active ids and selectedText into fallback action arguments", () => {
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
      customInstruction: "rewrite_experience",
    });
  });
});
