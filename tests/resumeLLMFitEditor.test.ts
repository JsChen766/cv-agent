import { describe, expect, it, vi } from "vitest";
import {
  ResumeLLMFitEditor,
  type ResumeFitEditorMeasureFn,
  type ResumeLLMFitEditorChatFn,
} from "../src/exports/ResumeLLMFitEditor.js";
import type { ProductResumeItem } from "../src/product/types.js";
import type { ResumeFitReport } from "../src/exports/ResumeFitService.js";
import type { ResumeCompressionReport } from "../src/exports/ResumeCompressionService.js";

const TEMPLATE = "one-page-modern";
const PROMPT = "You are the Resume Fit Editor (test stub prompt).";

function makeItem(
  id: string,
  bullets: Array<{ id: string; text: string; pinned?: boolean; optional?: boolean; relevance?: number }>,
  opts: { pinned?: boolean; relevanceScore?: number; sectionType?: ProductResumeItem["sectionType"] } = {},
): ProductResumeItem {
  const lines = ["Engineer \u00B7 Acme \u00B7 2020 - 2024"];
  const bulletPinned: Record<string, boolean> = {};
  const bulletOptional: Record<string, boolean> = {};
  const bulletRelevance: Record<string, number> = {};
  for (const b of bullets) {
    lines.push(`- ${b.text}`);
    if (b.pinned) bulletPinned[b.id] = true;
    if (b.optional) bulletOptional[b.id] = true;
    if (typeof b.relevance === "number") bulletRelevance[b.id] = b.relevance;
  }
  return {
    id,
    resumeId: "r-1",
    userId: "u-1",
    sectionType: opts.sectionType ?? "experience",
    title: `Item ${id}`,
    contentSnapshot: lines.join("\n"),
    orderIndex: 0,
    hidden: false,
    pinned: !!opts.pinned,
    metadata: {
      itemId: id,
      bulletIds: bullets.map((b) => b.id),
      bulletPinned,
      bulletOptional,
      bulletRelevance,
      relevanceScore: opts.relevanceScore ?? 0.5,
    },
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
}

function fitReport(overrides: Partial<ResumeFitReport> = {}): ResumeFitReport {
  return {
    targetPages: 1,
    estimatedPages: 1,
    overflowPx: 0,
    contentHeightPx: 800,
    pageUsableHeightPx: 987,
    templateId: TEMPLATE,
    density: "standard",
    measurer: "heuristic",
    measuredAt: new Date().toISOString(),
    ...overrides,
  };
}

function exhaustedCompressionReport(): ResumeCompressionReport {
  return {
    applied: true,
    initialEstimatedPages: 2,
    finalEstimatedPages: 2,
    initialOverflowPx: 200,
    finalOverflowPx: 150,
    iterations: 4,
    actions: [],
    densityBefore: "standard",
    densityAfter: "compact",
    stillOverflowing: true,
    reason: "no_more_strategies",
  };
}

describe("ResumeLLMFitEditor.shouldTrigger", () => {
  const editor = new ResumeLLMFitEditor({ prompt: PROMPT });

  it("returns null when there is no compression report and the page already fits", () => {
    expect(editor.shouldTrigger(fitReport({ overflowPx: 0, contentHeightPx: 950 }), undefined)).toBeNull();
  });

  it("triggers still_overflowing only after Phase 6 ran AND ended overflowing", () => {
    const compression = exhaustedCompressionReport();
    const result = editor.shouldTrigger(fitReport({ overflowPx: 150 }), compression);
    expect(result).toBe("still_overflowing");
  });

  it("does NOT trigger when overflow exists but Phase 6 never ran (compression bypassed)", () => {
    expect(editor.shouldTrigger(fitReport({ overflowPx: 150 }), undefined)).toBeNull();
  });

  it("triggers fill_underflow when overflowPx is 0 and underflow is large", () => {
    const fit = fitReport({ overflowPx: 0, contentHeightPx: 500, underflowPx: 487 });
    expect(editor.shouldTrigger(fit, undefined)).toBe("fill_underflow");
  });

  it("does not trigger fill_underflow for small underflow", () => {
    const fit = fitReport({ overflowPx: 0, contentHeightPx: 900, underflowPx: 87 });
    expect(editor.shouldTrigger(fit, undefined)).toBeNull();
  });

  it("does not trigger when wrong template even if overflowing after compression", () => {
    const fit = fitReport({ overflowPx: 150, templateId: "default" });
    expect(editor.shouldTrigger(fit, exhaustedCompressionReport())).toBeNull();
  });
});

describe("ResumeLLMFitEditor.edit (still_overflowing path)", () => {
  it("returns a no-op edit report with fallback=true when modelClient is missing", async () => {
    const editor = new ResumeLLMFitEditor({ prompt: PROMPT });
    const items = [makeItem("i-1", [{ id: "b-1", text: "did a thing" }])];
    const measure = vi.fn();
    const result = await editor.edit({
      items,
      density: "standard",
      fitReport: fitReport({ overflowPx: 100 }),
      compressionReport: exhaustedCompressionReport(),
      measure,
    });
    expect(result.editReport.applied).toBe(false);
    expect(result.editReport.fallback).toBe(true);
    expect(result.editReport.reason).toBe("no_model_client");
    expect(result.items).toBe(items);
    expect(measure).not.toHaveBeenCalled();
  });

  it("applies a valid drop_bullet action and re-measures", async () => {
    const items = [
      makeItem("i-1", [
        { id: "b-1", text: "Pinned achievement.", pinned: true },
        { id: "b-2", text: "Optional secondary task.", optional: true, relevance: 0.1 },
      ]),
    ];
    const chat: ResumeLLMFitEditorChatFn = vi.fn(async () => ({
      content: JSON.stringify({
        actions: [{ type: "drop_bullet", itemId: "i-1", bulletId: "b-2" }],
        reason: "shrink_to_fit",
        notes: "dropped 1 optional bullet",
      }),
    }));
    const measure: ResumeFitEditorMeasureFn = vi.fn(async (newItems) => {
      const stillBig = newItems[0].contentSnapshot.includes("Optional secondary task.");
      return fitReport({ overflowPx: stillBig ? 100 : 0, contentHeightPx: stillBig ? 1100 : 900 });
    });
    const editor = new ResumeLLMFitEditor({ prompt: PROMPT, chat });
    const result = await editor.edit({
      items,
      density: "standard",
      fitReport: fitReport({ overflowPx: 100, contentHeightPx: 1100 }),
      compressionReport: exhaustedCompressionReport(),
      measure,
    });

    expect(result.editReport.applied).toBe(true);
    expect(result.editReport.fallback).toBe(false);
    expect(result.editReport.trigger).toBe("still_overflowing");
    expect(result.editReport.actions).toHaveLength(1);
    expect(result.editReport.actions[0]).toMatchObject({ type: "drop_bullet", bulletId: "b-2" });
    expect(result.editReport.finalOverflowPx).toBe(0);
    expect(result.items[0].contentSnapshot).not.toContain("Optional secondary task.");
    expect(result.items[0].contentSnapshot).toContain("Pinned achievement.");
    expect(measure).toHaveBeenCalledTimes(1);
  });
});

describe("ResumeLLMFitEditor.edit (more shrink scenarios)", () => {
  it("applies shorten_bullet via newText and updates contentSnapshot", async () => {
    const long = "Built and shipped a complex distributed inventory system with multi-region replication, near-real-time sync, and automatic failover during three major retail peaks.";
    const items = [makeItem("i-1", [{ id: "b-1", text: long }])];
    const chat: ResumeLLMFitEditorChatFn = vi.fn(async () => ({
      content: JSON.stringify({
        actions: [{ type: "shorten_bullet", itemId: "i-1", bulletId: "b-1", newText: "Built distributed inventory system; multi-region sync and auto-failover." }],
        reason: "shrink_to_fit",
        notes: "shortened 1 bullet",
      }),
    }));
    const measure: ResumeFitEditorMeasureFn = vi.fn(async () => fitReport({ overflowPx: 0, contentHeightPx: 900 }));
    const editor = new ResumeLLMFitEditor({ prompt: PROMPT, chat });
    const result = await editor.edit({
      items,
      density: "standard",
      fitReport: fitReport({ overflowPx: 100 }),
      compressionReport: exhaustedCompressionReport(),
      measure,
    });
    expect(result.editReport.applied).toBe(true);
    expect(result.items[0].contentSnapshot).toContain("Built distributed inventory system; multi-region sync and auto-failover.");
    expect(result.items[0].contentSnapshot).not.toContain("multi-region replication");
  });

  it("rejects actions targeting unknown bullet ids without crashing", async () => {
    const items = [makeItem("i-1", [{ id: "b-1", text: "Real bullet." }])];
    const chat: ResumeLLMFitEditorChatFn = vi.fn(async () => ({
      content: JSON.stringify({
        actions: [
          { type: "drop_bullet", itemId: "i-1", bulletId: "b-99-FAKE" },
          { type: "drop_bullet", itemId: "i-1", bulletId: "b-1" },
        ],
        reason: "shrink_to_fit",
        notes: "ok",
      }),
    }));
    const measure: ResumeFitEditorMeasureFn = vi.fn(async () => fitReport({ overflowPx: 0, contentHeightPx: 900 }));
    const editor = new ResumeLLMFitEditor({ prompt: PROMPT, chat });
    const result = await editor.edit({
      items,
      density: "standard",
      fitReport: fitReport({ overflowPx: 100 }),
      compressionReport: exhaustedCompressionReport(),
      measure,
    });
    expect(result.editReport.applied).toBe(true);
    expect(result.editReport.actions).toHaveLength(1);
    expect(result.editReport.actions[0].bulletId).toBe("b-1");
    expect((result.editReport.rejectedActions ?? []).length).toBe(1);
  });

  it("refuses to drop or shorten pinned bullets even if the LLM tries", async () => {
    const items = [
      makeItem("i-1", [
        { id: "b-pin", text: "Critical pinned bullet must stay.", pinned: true },
        { id: "b-2", text: "Other.", optional: true },
      ]),
    ];
    const chat: ResumeLLMFitEditorChatFn = vi.fn(async () => ({
      content: JSON.stringify({
        actions: [
          { type: "drop_bullet", itemId: "i-1", bulletId: "b-pin" },
          { type: "shorten_bullet", itemId: "i-1", bulletId: "b-pin", newText: "trimmed" },
        ],
        reason: "shrink_to_fit",
        notes: "n",
      }),
    }));
    const measure: ResumeFitEditorMeasureFn = vi.fn(async () => fitReport({ overflowPx: 100, contentHeightPx: 1100 }));
    const editor = new ResumeLLMFitEditor({ prompt: PROMPT, chat });
    const result = await editor.edit({
      items,
      density: "standard",
      fitReport: fitReport({ overflowPx: 100, contentHeightPx: 1100 }),
      compressionReport: exhaustedCompressionReport(),
      measure,
    });
    expect(result.editReport.actions).toHaveLength(0);
    expect((result.editReport.rejectedActions ?? []).length).toBe(2);
    expect(result.items[0].contentSnapshot).toContain("Critical pinned bullet must stay.");
  });
});

describe("ResumeLLMFitEditor.edit (failure / safety paths)", () => {
  it("falls back to no-op when the LLM returns invalid JSON", async () => {
    const items = [makeItem("i-1", [{ id: "b-1", text: "Real bullet." }])];
    const chat: ResumeLLMFitEditorChatFn = vi.fn(async () => ({ content: "not json at all <<>>" }));
    const editor = new ResumeLLMFitEditor({ prompt: PROMPT, chat });
    const result = await editor.edit({
      items,
      density: "standard",
      fitReport: fitReport({ overflowPx: 100 }),
      compressionReport: exhaustedCompressionReport(),
      measure: vi.fn(),
    });
    expect(result.editReport.applied).toBe(false);
    expect(result.editReport.fallback).toBe(true);
    expect(result.editReport.reason).toBe("schema_invalid");
    expect(result.items).toBe(items);
  });

  it("falls back to no-op when the chat function throws", async () => {
    const items = [makeItem("i-1", [{ id: "b-1", text: "Real bullet." }])];
    const chat: ResumeLLMFitEditorChatFn = vi.fn(async () => {
      throw new Error("network down");
    });
    const editor = new ResumeLLMFitEditor({ prompt: PROMPT, chat });
    const result = await editor.edit({
      items,
      density: "standard",
      fitReport: fitReport({ overflowPx: 100 }),
      compressionReport: exhaustedCompressionReport(),
      measure: vi.fn(),
    });
    expect(result.editReport.applied).toBe(false);
    expect(result.editReport.fallback).toBe(true);
    expect(result.editReport.reason).toBe("model_error");
  });

  it("rolls back edits and reports fallback when post-edit measurement is worse than before", async () => {
    const items = [
      makeItem("i-1", [
        { id: "b-1", text: "First bullet text that is long enough to actually shorten." },
        { id: "b-2", text: "Second bullet text." },
      ]),
    ];
    const chat: ResumeLLMFitEditorChatFn = vi.fn(async () => ({
      content: JSON.stringify({
        actions: [{ type: "shorten_bullet", itemId: "i-1", bulletId: "b-1", newText: "shorter" }],
        reason: "shrink_to_fit",
        notes: "n",
      }),
    }));
    const before = fitReport({ overflowPx: 100, contentHeightPx: 1100 });
    const measure: ResumeFitEditorMeasureFn = vi.fn(async () => fitReport({ overflowPx: 200, contentHeightPx: 1300 }));
    const editor = new ResumeLLMFitEditor({ prompt: PROMPT, chat });
    const result = await editor.edit({
      items,
      density: "standard",
      fitReport: before,
      compressionReport: exhaustedCompressionReport(),
      measure,
    });
    expect(result.editReport.applied).toBe(false);
    expect(result.editReport.fallback).toBe(true);
    expect(result.editReport.reason).toBe("regression");
    expect(result.items).toBe(items);
  });

  it("limits the LLM to at most 6 actions even if it tries to send more", async () => {
    const bullets = Array.from({ length: 10 }, (_, i) => ({ id: `b-${i}`, text: `Bullet number ${i} with content`, optional: true, relevance: 0.1 }));
    const items = [makeItem("i-1", bullets)];
    const chat: ResumeLLMFitEditorChatFn = vi.fn(async () => ({
      content: JSON.stringify({
        actions: bullets.map((b) => ({ type: "drop_bullet", itemId: "i-1", bulletId: b.id })),
        reason: "shrink_to_fit",
        notes: "many",
      }),
    }));
    const measure: ResumeFitEditorMeasureFn = vi.fn(async () => fitReport({ overflowPx: 0, contentHeightPx: 900 }));
    const editor = new ResumeLLMFitEditor({ prompt: PROMPT, chat });
    const result = await editor.edit({
      items,
      density: "standard",
      fitReport: fitReport({ overflowPx: 100, contentHeightPx: 1100 }),
      compressionReport: exhaustedCompressionReport(),
      measure,
    });
    expect(result.editReport.applied).toBe(true);
    expect(result.editReport.actions.length).toBeLessThanOrEqual(6);
  });
});

describe("ResumeLLMFitEditor.edit (fill_underflow path)", () => {
  it("expands a short bullet using only existing facts when underflow is large", async () => {
    const items = [makeItem("i-1", [{ id: "b-1", text: "Built API." }])];
    const chat: ResumeLLMFitEditorChatFn = vi.fn(async () => ({
      content: JSON.stringify({
        actions: [{ type: "expand_bullet", itemId: "i-1", bulletId: "b-1", newText: "Built API at Acme as Engineer (2020-2024)." }],
        reason: "fill_underflow",
        notes: "expanded 1 short bullet using only header facts",
      }),
    }));
    const measure: ResumeFitEditorMeasureFn = vi.fn(async () => fitReport({ overflowPx: 0, contentHeightPx: 700, underflowPx: 287 }));
    const editor = new ResumeLLMFitEditor({ prompt: PROMPT, chat });
    const result = await editor.edit({
      items,
      density: "standard",
      fitReport: fitReport({ overflowPx: 0, contentHeightPx: 500, underflowPx: 487 }),
      compressionReport: undefined,
      measure,
    });
    expect(result.editReport.trigger).toBe("fill_underflow");
    expect(result.editReport.applied).toBe(true);
    expect(result.editReport.actions).toHaveLength(1);
    expect(result.editReport.actions[0].type).toBe("expand_bullet");
    expect(result.items[0].contentSnapshot).toContain("Built API at Acme as Engineer (2020-2024).");
  });

  it("rejects expand_bullet in shrink_to_fit mode", async () => {
    const items = [makeItem("i-1", [{ id: "b-1", text: "Built API." }])];
    const chat: ResumeLLMFitEditorChatFn = vi.fn(async () => ({
      content: JSON.stringify({
        actions: [{ type: "expand_bullet", itemId: "i-1", bulletId: "b-1", newText: "Lots more text" }],
        reason: "shrink_to_fit",
        notes: "n",
      }),
    }));
    const measure: ResumeFitEditorMeasureFn = vi.fn(async () => fitReport({ overflowPx: 0, contentHeightPx: 900 }));
    const editor = new ResumeLLMFitEditor({ prompt: PROMPT, chat });
    const result = await editor.edit({
      items,
      density: "standard",
      fitReport: fitReport({ overflowPx: 100, contentHeightPx: 1100 }),
      compressionReport: exhaustedCompressionReport(),
      measure,
    });
    expect(result.editReport.actions).toHaveLength(0);
    expect((result.editReport.rejectedActions ?? []).length).toBe(1);
  });
});