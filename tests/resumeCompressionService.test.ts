import { describe, expect, it } from "vitest";
import {
  ResumeCompressionService,
  type ResumeCompressionMeasureFn,
} from "../src/exports/ResumeCompressionService.js";
import type { ResumeFitReport } from "../src/exports/ResumeFitService.js";
import type { ProductResumeItem } from "../src/product/types.js";

function buildItem(overrides: Partial<ProductResumeItem> & { id: string }): ProductResumeItem {
  const now = "2025-01-01T00:00:00.000Z";
  return {
    id: overrides.id,
    resumeId: overrides.resumeId ?? "resume-1",
    userId: overrides.userId ?? "user-1",
    sourceExperienceId: overrides.sourceExperienceId,
    sourceVariantId: overrides.sourceVariantId,
    sourceArtifactId: overrides.sourceArtifactId,
    sectionType: overrides.sectionType ?? "experience",
    title: overrides.title ?? "Item title",
    contentSnapshot: overrides.contentSnapshot ?? "Item title \u00B7 Acme \u00B7 2022 \u2013 2024\n- bullet one\n- bullet two",
    orderIndex: overrides.orderIndex ?? 0,
    hidden: overrides.hidden ?? false,
    pinned: overrides.pinned ?? false,
    metadata: overrides.metadata ?? {},
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

function fitReport(overrides: Partial<ResumeFitReport>): ResumeFitReport {
  return {
    targetPages: overrides.targetPages ?? 1,
    estimatedPages: overrides.estimatedPages ?? 2,
    overflowPx: overrides.overflowPx ?? 200,
    contentHeightPx: overrides.contentHeightPx ?? 1200,
    pageUsableHeightPx: overrides.pageUsableHeightPx ?? 987,
    templateId: overrides.templateId ?? "one-page-modern",
    density: overrides.density ?? "standard",
    measurer: overrides.measurer ?? "heuristic",
    measuredAt: overrides.measuredAt ?? new Date().toISOString(),
    ...(overrides.underflowPx !== undefined ? { underflowPx: overrides.underflowPx } : {}),
  };
}

describe("ResumeCompressionService bypass conditions", () => {
  it("returns applied=false when fitReport has no overflow", async () => {
    const service = new ResumeCompressionService();
    const items = [buildItem({ id: "i-1" })];
    const measure: ResumeCompressionMeasureFn = async (_, density) => fitReport({ overflowPx: 0, estimatedPages: 1, density, underflowPx: 100 });

    const result = await service.compress({
      items,
      density: "standard",
      initialFitReport: fitReport({ overflowPx: 0, estimatedPages: 1, underflowPx: 100 }),
      measure,
    });

    expect(result.compressionReport.applied).toBe(false);
    expect(result.items).toEqual(items);
    expect(result.density).toBe("standard");
    expect(result.compressionReport.actions).toEqual([]);
    expect(result.compressionReport.iterations).toBe(0);
    expect(result.compressionReport.reason).toBe("overflow_resolved");
  });

  it("returns applied=false for non one-page-modern templates", async () => {
    const service = new ResumeCompressionService();
    const items = [buildItem({ id: "i-1" })];
    const measure: ResumeCompressionMeasureFn = async (_, density) => fitReport({ overflowPx: 200, density });

    const result = await service.compress({
      items,
      density: "standard",
      initialFitReport: fitReport({ overflowPx: 200, templateId: "default" }),
      measure,
    });

    expect(result.compressionReport.applied).toBe(false);
    expect(result.items).toEqual(items);
  });

  it("returns applied=false when targetPages is not 1", async () => {
    const service = new ResumeCompressionService();
    const items = [buildItem({ id: "i-1" })];
    const measure: ResumeCompressionMeasureFn = async (_, density) => fitReport({ overflowPx: 200, density });

    const result = await service.compress({
      items,
      density: "standard",
      initialFitReport: fitReport({ overflowPx: 200, targetPages: 2 }),
      measure,
    });

    expect(result.compressionReport.applied).toBe(false);
  });
});

describe("ResumeCompressionService strategy: drop optional + low-relevance bullets", () => {
  it("drops bullets with metadata.bulletOptional=true (low relevance) first", async () => {
    const service = new ResumeCompressionService();
    const items = [
      buildItem({
        id: "i-1",
        contentSnapshot: "Senior \u00B7 Acme \u00B7 2022 \u2013 2024\n- bullet keep one\n- bullet optional one\n- bullet keep two",
        metadata: {
          itemId: "i-1",
          bulletIds: ["b-keep-1", "b-opt-1", "b-keep-2"],
          bulletOptional: { "b-opt-1": true },
          bulletRelevance: { "b-keep-1": 0.9, "b-opt-1": 0.1, "b-keep-2": 0.8 },
        },
      }),
    ];
    const measure: ResumeCompressionMeasureFn = async (currentItems, density) => {
      const allText = currentItems.map((i) => i.contentSnapshot).join("\n");
      const stillHasOptional = allText.includes("bullet optional one");
      return fitReport({
        overflowPx: stillHasOptional ? 200 : 0,
        estimatedPages: stillHasOptional ? 2 : 1,
        density,
        ...(stillHasOptional ? {} : { underflowPx: 0 }),
      });
    };

    const result = await service.compress({
      items,
      density: "standard",
      initialFitReport: fitReport({ overflowPx: 200 }),
      measure,
    });

    expect(result.compressionReport.applied).toBe(true);
    expect(result.compressionReport.finalOverflowPx).toBe(0);
    const dropActions = result.compressionReport.actions.filter((a) => a.type === "drop_bullet");
    expect(dropActions.length).toBe(1);
    expect(dropActions[0]).toMatchObject({
      type: "drop_bullet",
      itemId: "i-1",
      bulletText: "bullet optional one",
      reason: "optional_low_relevance",
    });
    expect(result.items[0].contentSnapshot).not.toContain("bullet optional one");
    expect(result.items[0].contentSnapshot).toContain("bullet keep one");
    expect(result.items[0].contentSnapshot).toContain("bullet keep two");
    expect((result.items[0].metadata as Record<string, unknown>).bulletIds).toEqual(["b-keep-1", "b-keep-2"]);
  });

  it("never drops a pinned bullet even if optional/low-relevance", async () => {
    const service = new ResumeCompressionService();
    const items = [
      buildItem({
        id: "i-1",
        contentSnapshot: "Title \u00B7 Acme \u00B7 2022 \u2013 2024\n- pinned-bullet\n- regular-bullet",
        metadata: {
          itemId: "i-1",
          bulletIds: ["b-pinned", "b-reg"],
          bulletOptional: { "b-pinned": true, "b-reg": true },
          bulletPinned: { "b-pinned": true },
          bulletRelevance: { "b-pinned": 0.05, "b-reg": 0.05 },
        },
      }),
    ];
    const measure: ResumeCompressionMeasureFn = async (currentItems, density) => {
      const text = currentItems.map((i) => i.contentSnapshot).join("\n");
      const hasReg = text.includes("regular-bullet");
      return fitReport({ overflowPx: hasReg ? 200 : 0, density });
    };

    const result = await service.compress({
      items,
      density: "standard",
      initialFitReport: fitReport({ overflowPx: 200 }),
      measure,
    });

    expect(result.items[0].contentSnapshot).toContain("pinned-bullet");
    expect(result.items[0].contentSnapshot).not.toContain("regular-bullet");
    const drops = result.compressionReport.actions.filter((a) => a.type === "drop_bullet");
    expect(drops.every((d) => d.type !== "drop_bullet" || d.bulletId !== "b-pinned")).toBe(true);
  });
});

describe("ResumeCompressionService strategy: shorten long bullets", () => {
  it("shortens long bullets when no optional bullets remain and overflow persists", async () => {
    const service = new ResumeCompressionService();
    const longText = "this is a deliberately long bullet that should be shortened by the compressor when overflow persists after the optional pass and we still have more page than fits within the A4 budget";
    const items = [
      buildItem({
        id: "i-1",
        contentSnapshot: `Title \u00B7 Acme \u00B7 2022 \u2013 2024\n- ${longText}${longText}\n- short two`,
        metadata: { itemId: "i-1", bulletIds: ["b-long", "b-short"] },
      }),
    ];
    const measure: ResumeCompressionMeasureFn = async (currentItems, density) => {
      const text = currentItems.map((i) => i.contentSnapshot).join("\n");
      const longLine = text.split("\n").find((line) => line.startsWith("- ") && line.length > 50) ?? "";
      const stillLong = longLine.length > 200;
      return fitReport({ overflowPx: stillLong ? 200 : 0, density });
    };

    const result = await service.compress({
      items,
      density: "standard",
      initialFitReport: fitReport({ overflowPx: 200 }),
      measure,
    });

    expect(result.compressionReport.applied).toBe(true);
    const shortenActions = result.compressionReport.actions.filter((a) => a.type === "shorten_bullet");
    expect(shortenActions.length).toBeGreaterThanOrEqual(1);
    const action = shortenActions[0];
    if (action.type !== "shorten_bullet") throw new Error("expected shorten_bullet action");
    expect(action.before.length).toBeGreaterThan(action.after.length);
    expect(action.after).toMatch(/\u2026$|\.{3}$/);
    expect(result.items[0].contentSnapshot.length).toBeLessThan(longText.length * 2);
  });
});

describe("ResumeCompressionService strategy: hide low-relevance items", () => {
  it("hides items with the lowest metadata.relevanceScore last when bullet-level passes are exhausted", async () => {
    const service = new ResumeCompressionService();
    const items = [
      buildItem({
        id: "i-keep",
        title: "Keep me",
        contentSnapshot: "Keep me\n- keep one",
        metadata: { itemId: "i-keep", bulletIds: ["bk-1"], relevanceScore: 0.95 },
      }),
      buildItem({
        id: "i-low",
        title: "Drop me",
        contentSnapshot: "Drop me\n- low one",
        metadata: { itemId: "i-low", bulletIds: ["bl-1"], relevanceScore: 0.1 },
      }),
    ];
    const measure: ResumeCompressionMeasureFn = async (currentItems, density) => {
      const visible = currentItems.filter((i) => !i.hidden);
      const hasLow = visible.some((i) => i.id === "i-low");
      return fitReport({ overflowPx: hasLow ? 200 : 0, density });
    };

    const result = await service.compress({
      items,
      density: "standard",
      initialFitReport: fitReport({ overflowPx: 200 }),
      measure,
    });

    const keep = result.items.find((i) => i.id === "i-keep");
    const low = result.items.find((i) => i.id === "i-low");
    expect(keep?.hidden).toBe(false);
    expect(low?.hidden).toBe(true);
    const hideActions = result.compressionReport.actions.filter((a) => a.type === "hide_item");
    expect(hideActions.length).toBe(1);
    if (hideActions[0].type !== "hide_item") throw new Error("expected hide_item");
    expect(hideActions[0].itemId).toBe("i-low");
  });

  it("never hides a pinned item even if relevance is low", async () => {
    const service = new ResumeCompressionService();
    const items = [
      buildItem({
        id: "i-keep",
        title: "Keep",
        contentSnapshot: "Keep\n- a",
        metadata: { relevanceScore: 0.9 },
      }),
      buildItem({
        id: "i-pinned",
        title: "Pinned",
        contentSnapshot: "Pinned\n- p",
        pinned: true,
        metadata: { relevanceScore: 0.05 },
      }),
    ];
    let attempts = 0;
    const measure: ResumeCompressionMeasureFn = async (_, density) => {
      attempts += 1;
      // Always overflow to force exhaustion.
      return fitReport({ overflowPx: 500, density });
    };

    const result = await service.compress({
      items,
      density: "standard",
      initialFitReport: fitReport({ overflowPx: 500 }),
      measure,
    });

    const pinned = result.items.find((i) => i.id === "i-pinned");
    expect(pinned?.hidden).toBe(false);
    // even after exhaustion, pinned item is not hidden
    expect(attempts).toBeGreaterThan(0);
  });
});

describe("ResumeCompressionService strategy: drop density", () => {
  it("downgrades density from standard to compact as a final rule-based step", async () => {
    const service = new ResumeCompressionService();
    const items = [
      buildItem({ id: "i-1", contentSnapshot: "Title\n- one\n- two", metadata: { itemId: "i-1", bulletIds: ["b1", "b2"] } }),
    ];
    const measure: ResumeCompressionMeasureFn = async (_, density) => {
      const overflowPx = density === "compact" ? 0 : 200;
      return fitReport({ overflowPx, density });
    };

    const result = await service.compress({
      items,
      density: "standard",
      initialFitReport: fitReport({ overflowPx: 200 }),
      measure,
    });

    expect(result.density).toBe("compact");
    const densityActions = result.compressionReport.actions.filter((a) => a.type === "drop_density");
    expect(densityActions.length).toBe(1);
    if (densityActions[0].type !== "drop_density") throw new Error("expected drop_density");
    expect(densityActions[0].from).toBe("standard");
    expect(densityActions[0].to).toBe("compact");
    expect(result.compressionReport.densityBefore).toBe("standard");
    expect(result.compressionReport.densityAfter).toBe("compact");
    expect(result.compressionReport.finalOverflowPx).toBe(0);
  });
});

describe("ResumeCompressionService iteration & exhaustion", () => {
  it("stops with stillOverflowing=true when all strategies are exhausted but content still overflows", async () => {
    const service = new ResumeCompressionService();
    const items = [
      buildItem({ id: "i-1", contentSnapshot: "Title\n- only", pinned: true, metadata: { itemId: "i-1", bulletIds: ["b1"], bulletPinned: { b1: true } } }),
    ];
    const measure: ResumeCompressionMeasureFn = async (_, density) => fitReport({ overflowPx: 800, density });

    const result = await service.compress({
      items,
      density: "standard",
      initialFitReport: fitReport({ overflowPx: 800 }),
      measure,
    });

    expect(result.compressionReport.applied).toBe(true);
    expect(result.compressionReport.stillOverflowing).toBe(true);
    expect(result.compressionReport.reason).toBe("no_more_strategies");
    expect(result.compressionReport.finalOverflowPx).toBe(800);
  });

  it("records initial vs final estimatedPages and a non-zero iteration count when work is done", async () => {
    const service = new ResumeCompressionService();
    const items = [
      buildItem({
        id: "i-1",
        contentSnapshot: "Title\n- keep\n- drop",
        metadata: {
          itemId: "i-1",
          bulletIds: ["bk", "bd"],
          bulletOptional: { bd: true },
          bulletRelevance: { bk: 0.9, bd: 0.1 },
        },
      }),
    ];
    const measure: ResumeCompressionMeasureFn = async (currentItems, density) => {
      const text = currentItems.map((i) => i.contentSnapshot).join("\n");
      const has = text.includes("drop");
      return fitReport({
        overflowPx: has ? 200 : 0,
        estimatedPages: has ? 2 : 1,
        density,
        ...(has ? {} : { underflowPx: 0 }),
      });
    };

    const result = await service.compress({
      items,
      density: "standard",
      initialFitReport: fitReport({ overflowPx: 200, estimatedPages: 2 }),
      measure,
    });

    expect(result.compressionReport.initialEstimatedPages).toBe(2);
    expect(result.compressionReport.finalEstimatedPages).toBe(1);
    expect(result.compressionReport.initialOverflowPx).toBe(200);
    expect(result.compressionReport.finalOverflowPx).toBe(0);
    expect(result.compressionReport.iterations).toBeGreaterThan(0);
    expect(result.compressionReport.stillOverflowing).toBe(false);
    expect(result.compressionReport.reason).toBe("overflow_resolved");
  });
});
