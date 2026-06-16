import { describe, expect, it } from "vitest";
import {
  BaseWorkspacePatchSchema,
  BaseActionResultSchema,
  BaseToolResultSchema,
  ListResumesOutputSchema,
  GetResumeOutputSchema,
  AcceptGenerationVariantOutputSchema,
  PrepareReviseResumeItemOutputSchema,
  ReviseResumeItemOutputSchema,
} from "../src/agent-core/validation/ToolOutputSchemas.js";
import {
  ToolResultSchema,
  ToolResultEntitySchema,
  ToolResultEvidenceSchema,
  ToolResultNextActionHintSchema,
} from "../src/agent-core/validation/ToolInputSchemas.js";

describe("BaseWorkspacePatchSchema", () => {
  it("accepts a minimal workspacePatch with activePanel", () => {
    const result = BaseWorkspacePatchSchema.safeParse({ activePanel: "resume_history" });
    expect(result.success).toBe(true);
  });

  it("accepts empty object (no patch)", () => {
    const result = BaseWorkspacePatchSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts unknown extra fields via passthrough", () => {
    const result = BaseWorkspacePatchSchema.safeParse({
      activePanel: "variants",
      extraField: 123,
      nested: { key: "value" },
    });
    expect(result.success).toBe(true);
  });
});

describe("BaseActionResultSchema", () => {
  it("accepts a typical success actionResult", () => {
    const result = BaseActionResultSchema.safeParse({
      status: "success",
      actionType: "generate_resume_from_jd",
      metadata: { generationId: "gen-1", variantCount: 3 },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a needs_input actionResult with reason", () => {
    const result = BaseActionResultSchema.safeParse({
      status: "needs_input",
      actionType: "prepare_revise_resume_item",
      reason: "source_text_not_found",
    });
    expect(result.success).toBe(true);
  });

  it("accepts unknown extra fields via passthrough", () => {
    const result = BaseActionResultSchema.safeParse({
      actionType: "test",
      revisionSuggestion: { kind: "resume_item" },
    });
    expect(result.success).toBe(true);
  });
});

describe("BaseToolResultSchema", () => {
  it("accepts a minimal success result", () => {
    const result = BaseToolResultSchema.safeParse({
      status: "success",
      message: "ok",
      data: { count: 1 },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a result with workspacePatch and actionResult", () => {
    const result = BaseToolResultSchema.safeParse({
      status: "success",
      message: "done",
      data: { items: [] },
      workspacePatch: { activePanel: "variants" },
      actionResult: { actionType: "generate_resume_from_jd", status: "success" },
      visibility: "user_summary",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid status", () => {
    const result = BaseToolResultSchema.safeParse({ status: "invalid_status" });
    expect(result.success).toBe(false);
  });
});

describe("ListResumesOutputSchema", () => {
  it("accepts typical list_resumes output", () => {
    const output = {
      status: "success" as const,
      message: "Found 2 resume(s).",
      data: { count: 2, items: [{ id: "r1", title: "My Resume", status: "draft" }] },
      workspacePatch: { activePanel: "resume_history", resumes: [] },
      visibility: "internal" as const,
    };
    const result = ListResumesOutputSchema.safeParse(output);
    expect(result.success).toBe(true);
  });

  it("accepts list_resumes output with extra data fields", () => {
    const output = {
      status: "success" as const,
      data: {
        count: 0,
        items: [],
        extraField: "allowed",
      },
    };
    const result = ListResumesOutputSchema.safeParse(output);
    expect(result.success).toBe(true);
  });

  it("rejects list_resumes output missing data.count", () => {
    const output = {
      status: "success" as const,
      data: { items: [] },
    };
    const result = ListResumesOutputSchema.safeParse(output);
    expect(result.success).toBe(false);
  });
});

describe("GetResumeOutputSchema", () => {
  it("accepts successful get_resume output", () => {
    const output = {
      status: "success" as const,
      message: 'Loaded resume "My CV".',
      data: { resume: { id: "r1", title: "My CV", status: "draft" } },
      workspacePatch: {
        activePanel: "resume_editor",
        resumeId: "r1",
        activeResume: { id: "r1" },
        active: { resumeId: "r1" },
      },
      visibility: "internal" as const,
    };
    const result = GetResumeOutputSchema.safeParse(output);
    expect(result.success).toBe(true);
  });

  it("accepts failed get_resume output", () => {
    const output = {
      status: "failed" as const,
      message: "Resume not found.",
      data: { id: "r-missing" },
      visibility: "error_user_visible" as const,
    };
    const result = GetResumeOutputSchema.safeParse(output);
    expect(result.success).toBe(true);
  });

  it("rejects get_resume output with wrong activePanel", () => {
    const output = {
      status: "success" as const,
      data: { resume: { id: "r1" } },
      workspacePatch: { activePanel: "wrong_panel", resumeId: "r1", activeResume: {}, active: { resumeId: "r1" } },
    };
    const result = GetResumeOutputSchema.safeParse(output);
    expect(result.success).toBe(false);
  });
});

describe("AcceptGenerationVariantOutputSchema", () => {
  it("accepts typical success output", () => {
    const output = {
      status: "success" as const,
      message: "已将选中的版本保存到简历。",
      data: {
        generation: { id: "gen-1" },
        resume: { id: "res-1", title: "My CV" },
        item: { id: "item-1", content: "..." },
        variant: { id: "var-1", content: "..." },
      },
      workspacePatch: {
        activePanel: "resume_editor",
        resumeId: "res-1",
        activeResume: { id: "res-1" },
        active: { resumeId: "res-1", variantId: "var-1" },
        status: "accepted",
        summary: "已将选中的版本保存到简历。",
      },
      actionResult: {
        status: "success",
        actionType: "accept_generation_variant",
        variantId: "var-1",
        metadata: { generationId: "gen-1", resumeId: "res-1" },
      },
      visibility: "user_summary" as const,
    };
    const result = AcceptGenerationVariantOutputSchema.safeParse(output);
    expect(result.success).toBe(true);
  });

  it("rejects missing generationId in actionResult.metadata", () => {
    const output = {
      status: "success" as const,
      data: { generation: {}, resume: {}, item: {}, variant: {} },
      workspacePatch: {
        activePanel: "resume_editor", resumeId: "r1", activeResume: {},
        active: { resumeId: "r1" }, status: "accepted",
      },
      actionResult: {
        status: "success", actionType: "accept_generation_variant",
        variantId: "v1",
        metadata: { resumeId: "r1" }, // missing generationId
      },
      visibility: "user_summary" as const,
    };
    const result = AcceptGenerationVariantOutputSchema.safeParse(output);
    expect(result.success).toBe(false);
  });
});

describe("PrepareReviseResumeItemOutputSchema", () => {
  it("accepts success path with revisionSuggestion", () => {
    const output = {
      status: "success" as const,
      message: "LLM generated rewrite preview.",
      data: {
        resumeItemId: "item-1",
        rewrittenText: "Improved bullet point text.",
        sourceTextPreview: "Original text...",
      },
      visibility: "user_summary" as const,
      actionResult: {
        status: "success" as const,
        actionType: "prepare_revise_resume_item" as const,
        revisionSuggestion: {
          kind: "resume_item" as const,
          sourceId: "item-1",
          rewrittenText: "Improved bullet point text.",
          usedModel: true,
          changes: [],
        },
        metadata: {
          nextAction: "revise_resume_item" as const,
          requiresConfirmation: true as const,
          usedModel: true,
        },
      },
    };
    const result = PrepareReviseResumeItemOutputSchema.safeParse(output);
    expect(result.success).toBe(true);
  });

  it("accepts needs_input path (source_text_not_found)", () => {
    const output = {
      status: "needs_input" as const,
      message: "找不到该简历条目的原文。",
      data: { resumeItemId: "item-1" },
      visibility: "error_user_visible" as const,
      actionResult: {
        status: "needs_input" as const,
        actionType: "prepare_revise_resume_item" as const,
        reason: "source_text_not_found" as const,
      },
    };
    const result = PrepareReviseResumeItemOutputSchema.safeParse(output);
    expect(result.success).toBe(true);
  });

  it("rejects missing rewrittenText in success path", () => {
    const output = {
      status: "success" as const,
      message: "ok",
      data: { resumeItemId: "item-1" },
      visibility: "user_summary" as const,
      actionResult: {
        status: "success" as const,
        actionType: "prepare_revise_resume_item" as const,
        revisionSuggestion: {
          kind: "resume_item" as const,
          sourceId: "item-1",
          rewrittenText: "", // empty — will fail
          usedModel: true,
        },
      },
    };
    const result = PrepareReviseResumeItemOutputSchema.safeParse(output);
    expect(result.success).toBe(false);
  });
});

describe("ReviseResumeItemOutputSchema", () => {
  it("accepts success path with item and rewrittenText", () => {
    const output = {
      status: "success" as const,
      message: "已根据你的指令优化该简历条目。",
      data: { item: { id: "item-1", contentSnapshot: "new text" }, rewrittenText: "new text" },
      workspacePatch: { activePanel: "resume_editor" },
      visibility: "user_summary" as const,
      actionResult: {
        status: "success" as const,
        actionType: "optimize_resume_item" as const,
        revisionSuggestion: {
          kind: "resume_item" as const,
          sourceId: "item-1",
          sourceTextPreview: "old text",
          rewrittenText: "new text",
          usedModel: true,
        },
      },
    };
    const result = ReviseResumeItemOutputSchema.safeParse(output);
    expect(result.success).toBe(true);
  });

  it("accepts needs_input path (no_rewritten_text)", () => {
    const output = {
      status: "needs_input" as const,
      message: "Please preview the rewrite before confirming.",
      visibility: "error_user_visible" as const,
      actionResult: {
        status: "needs_input" as const,
        actionType: "revise_resume_item" as const,
        reason: "no_rewritten_text" as const,
        message: "Please preview the rewrite before confirming.",
      },
    };
    const result = ReviseResumeItemOutputSchema.safeParse(output);
    expect(result.success).toBe(true);
  });

  it("accepts failed path (item not found)", () => {
    const output = {
      status: "failed" as const,
      message: "Resume item not found.",
      data: { id: "item-missing" },
      visibility: "error_user_visible" as const,
    };
    const result = ReviseResumeItemOutputSchema.safeParse(output);
    expect(result.success).toBe(true);
  });

  it("rejects invalid reason in needs_input path", () => {
    const output = {
      status: "needs_input" as const,
      message: "bad",
      visibility: "error_user_visible" as const,
      actionResult: {
        status: "needs_input" as const,
        actionType: "revise_resume_item" as const,
        reason: "invalid_reason",
      },
    };
    const result = ReviseResumeItemOutputSchema.safeParse(output);
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────
// Phase 1: structured ToolResult fields (back-compat + new fields)
// ─────────────────────────────────────────────────────────────────

describe("Phase 1 — ToolResultSchema structured fields", () => {
  it("accepts a legacy result with no Phase 1 fields (back-compat)", () => {
    const legacy = {
      status: "success" as const,
      message: "ok",
      data: { count: 1 },
      workspacePatch: { activePanel: "variants" },
      actionResult: { status: "success", actionType: "noop" },
      visibility: "user_summary" as const,
    };
    const ok = ToolResultSchema.safeParse(legacy);
    expect(ok.success).toBe(true);
    const baseOk = BaseToolResultSchema.safeParse(legacy);
    expect(baseOk.success).toBe(true);
  });

  it("accepts a result that carries summaryFacts / entities / evidence / warnings / nextActionHints", () => {
    const enriched = {
      status: "success" as const,
      message: "Generated 2 variants.",
      data: { generationId: "gen-1" },
      visibility: "user_summary" as const,
      resultKind: "generation_completed",
      summaryFacts: [
        "Generated 2 resume variants from JD jd-1.",
        "Recommended variant: var-2.",
      ],
      entities: [
        { type: "generation", id: "gen-1", title: "Frontend Engineer - generation" },
        { type: "resume_variant", id: "var-1", title: "Variant 1" },
        { type: "resume_variant", id: "var-2", title: "Variant 2" },
      ],
      evidence: [
        { sourceId: "exp-7", claim: "Owns Vue 3 perf work", support: "Reduced TTI by 40%", confidence: 0.92 },
      ],
      warnings: ["No high-match experiences for this JD."],
      nextActionHints: [
        { type: "accept_generation_variant", label: "Save this variant", payload: { variantId: "var-2" } },
        { type: "review_variants", label: "Compare variants", payload: { generationId: "gen-1" } },
      ],
    };
    const ok = ToolResultSchema.safeParse(enriched);
    expect(ok.success).toBe(true);
    const baseOk = BaseToolResultSchema.safeParse(enriched);
    expect(baseOk.success).toBe(true);
  });

  it("rejects entity without a `type`", () => {
    const result = ToolResultEntitySchema.safeParse({ id: "x" });
    expect(result.success).toBe(false);
  });

  it("rejects evidence with confidence outside [0,1]", () => {
    const tooHigh = ToolResultEvidenceSchema.safeParse({ confidence: 1.5 });
    expect(tooHigh.success).toBe(false);
    const negative = ToolResultEvidenceSchema.safeParse({ confidence: -0.1 });
    expect(negative.success).toBe(false);
  });

  it("rejects nextActionHint without a label", () => {
    const result = ToolResultNextActionHintSchema.safeParse({ type: "export_resume" });
    expect(result.success).toBe(false);
  });

  it("rejects summaryFacts as a single string (must be an array)", () => {
    const result = ToolResultSchema.safeParse({
      status: "success",
      summaryFacts: "Generated 2 variants.",
    });
    expect(result.success).toBe(false);
  });
});
