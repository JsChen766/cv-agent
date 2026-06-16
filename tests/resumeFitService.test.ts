import { describe, expect, it } from "vitest";
import {
  A4_USABLE_HEIGHT_PX,
  HeuristicLayoutMeasurer,
  ResumeFitMeasureError,
  ResumeFitService,
  buildFitReport,
  computeHeuristicHeight,
  type ResumeLayoutMeasurer,
} from "../src/exports/ResumeFitService.js";
import { onePageModernTemplate } from "../src/exports/templates/onePageModernTemplate.js";
import type { ProductResumeDetail, ProductResumeItem } from "../src/product/types.js";

function buildItem(over: Partial<ProductResumeItem> = {}): ProductResumeItem {
  const now = "2025-01-01T00:00:00.000Z";
  return {
    id: over.id ?? "item-1",
    resumeId: over.resumeId ?? "resume-1",
    userId: over.userId ?? "user-1",
    sourceExperienceId: over.sourceExperienceId,
    sourceVariantId: over.sourceVariantId,
    sourceArtifactId: over.sourceArtifactId,
    sectionType: over.sectionType ?? "experience",
    title: over.title ?? "Senior Engineer",
    contentSnapshot: over.contentSnapshot ?? "Senior Engineer",
    orderIndex: over.orderIndex ?? 0,
    hidden: over.hidden ?? false,
    pinned: over.pinned ?? false,
    metadata: over.metadata ?? {},
    createdAt: over.createdAt ?? now,
    updatedAt: over.updatedAt ?? now,
  };
}

function buildResume(items: ProductResumeItem[], over: Partial<ProductResumeDetail> = {}): ProductResumeDetail {
  const now = "2025-01-01T00:00:00.000Z";
  return {
    id: over.id ?? "resume-1",
    userId: over.userId ?? "user-1",
    title: over.title ?? "Jane Doe",
    targetRole: over.targetRole,
    jdId: over.jdId,
    templateId: over.templateId,
    status: over.status ?? "draft",
    createdAt: over.createdAt ?? now,
    updatedAt: over.updatedAt ?? now,
    items,
  };
}

describe("buildFitReport", () => {
  it("clamps estimatedPages to >=1 and computes underflowPx for short content", () => {
    const report = buildFitReport({
      contentHeightPx: 200,
      pageUsableHeightPx: 1000,
      templateId: "one-page-modern",
      density: "standard",
      measurer: "heuristic",
    });
    expect(report.targetPages).toBe(1);
    expect(report.estimatedPages).toBe(1);
    expect(report.overflowPx).toBe(0);
    expect(report.underflowPx).toBe(800);
    expect(report.contentHeightPx).toBe(200);
    expect(report.pageUsableHeightPx).toBe(1000);
    expect(report.templateId).toBe("one-page-modern");
    expect(report.density).toBe("standard");
    expect(report.measurer).toBe("heuristic");
    expect(report.measuredAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("computes overflowPx and estimatedPages>1 for long content, omitting underflowPx", () => {
    const report = buildFitReport({
      contentHeightPx: 2400,
      pageUsableHeightPx: 1000,
      templateId: "one-page-modern",
      density: "standard",
      measurer: "heuristic",
    });
    expect(report.estimatedPages).toBe(3);
    expect(report.overflowPx).toBe(1400);
    expect(report.underflowPx).toBeUndefined();
  });

  it("treats targetPages>1 correctly so future phases can request multi-page targets", () => {
    const report = buildFitReport({
      contentHeightPx: 1800,
      pageUsableHeightPx: 1000,
      templateId: "one-page-modern",
      density: "compact",
      measurer: "playwright",
      targetPages: 2,
    });
    expect(report.targetPages).toBe(2);
    expect(report.estimatedPages).toBe(2);
    expect(report.overflowPx).toBe(0);
    expect(report.underflowPx).toBe(200);
  });
});

describe("HeuristicLayoutMeasurer", () => {
  it("returns small contentHeight for a short single-bullet resume", async () => {
    const html = onePageModernTemplate().render({
      resume: buildResume([
        buildItem({
          contentSnapshot: "Senior Engineer \u00B7 Acme \u00B7 2022 \u2013 2024\n- Built reliable systems",
          metadata: { sectionType: "experience", sectionOrder: 1, itemId: "i-1", bulletIds: ["b-1"] },
        }),
      ]),
    });
    const measurer = new HeuristicLayoutMeasurer();
    const result = await measurer.measure({ html, templateId: "one-page-modern", density: "standard" });
    expect(result.measurer).toBe("heuristic");
    expect(result.pageUsableHeightPx).toBe(A4_USABLE_HEIGHT_PX);
    expect(result.contentHeightPx).toBeGreaterThan(0);
    expect(result.contentHeightPx).toBeLessThan(A4_USABLE_HEIGHT_PX);
  });

  it("reports overflow for an unrealistically long resume", async () => {
    const items: ProductResumeItem[] = [];
    for (let i = 0; i < 12; i += 1) {
      const bullets = Array.from({ length: 6 }, (_, j) => `- This is a long bullet ${i}.${j} ${"x".repeat(80)}`).join("\n");
      items.push(
        buildItem({
          id: `i-${i}`,
          title: `Role ${i}`,
          contentSnapshot: `Role ${i} \u00B7 Company ${i} \u00B7 2020 \u2013 2024\n${bullets}`,
          orderIndex: i,
          metadata: { sectionType: "experience", sectionOrder: 1, itemId: `doc-${i}`, bulletIds: [] },
        }),
      );
    }
    const html = onePageModernTemplate().render({ resume: buildResume(items) });
    const measurer = new HeuristicLayoutMeasurer();
    const result = await measurer.measure({ html, templateId: "one-page-modern", density: "standard" });
    expect(result.contentHeightPx).toBeGreaterThan(A4_USABLE_HEIGHT_PX);
  });

  it("scales height monotonically with density: compact < standard < comfortable", () => {
    const html = onePageModernTemplate().render({
      resume: buildResume([
        buildItem({
          contentSnapshot: "Role A \u00B7 Co \u00B7 2022 \u2013 2024\n- Bullet one\n- Bullet two\n- Bullet three",
          metadata: { sectionType: "experience" },
        }),
        buildItem({
          id: "i-2",
          contentSnapshot: "Role B \u00B7 Co \u00B7 2020 \u2013 2022\n- Bullet four\n- Bullet five",
          metadata: { sectionType: "experience" },
        }),
      ]),
    });
    const compact = computeHeuristicHeight(html, "compact");
    const standard = computeHeuristicHeight(html, "standard");
    const comfortable = computeHeuristicHeight(html, "comfortable");
    expect(compact).toBeLessThan(standard);
    expect(standard).toBeLessThan(comfortable);
  });

  it("counts skill chips as rows of ~6 chips", () => {
    const html = onePageModernTemplate().render({
      resume: buildResume([
        buildItem({
          sectionType: "skill",
          title: "Skills",
          contentSnapshot: "TypeScript, React, Node, Vue, Postgres, Redis, Docker, Kubernetes, GraphQL, gRPC, Rust, Go",
        }),
      ]),
    });
    const measured = computeHeuristicHeight(html, "standard");
    // Masthead + sectionGap + sectionTitle + 2 chip rows (~26px each) — must
    // be < an entire A4 page; ensures chip-row counting is sane.
    expect(measured).toBeGreaterThan(0);
    expect(measured).toBeLessThan(A4_USABLE_HEIGHT_PX);
  });
});

describe("ResumeFitService", () => {
  it("delegates to the injected measurer and returns a fully-populated report", async () => {
    const stubMeasurer: ResumeLayoutMeasurer = {
      async measure(input) {
        expect(input.html).toBe("<html></html>");
        expect(input.templateId).toBe("one-page-modern");
        expect(input.density).toBe("compact");
        return { contentHeightPx: 980, pageUsableHeightPx: 1000, measurer: "heuristic" };
      },
    };
    const service = new ResumeFitService(stubMeasurer);
    const report = await service.measure({
      html: "<html></html>",
      templateId: "one-page-modern",
      density: "compact",
    });
    expect(report.contentHeightPx).toBe(980);
    expect(report.pageUsableHeightPx).toBe(1000);
    expect(report.estimatedPages).toBe(1);
    expect(report.overflowPx).toBe(0);
    expect(report.underflowPx).toBe(20);
    expect(report.templateId).toBe("one-page-modern");
    expect(report.density).toBe("compact");
    expect(report.measurer).toBe("heuristic");
    expect(typeof report.measuredAt).toBe("string");
  });

  it("propagates ResumeFitMeasureError from the measurer up to the caller", async () => {
    const failing: ResumeLayoutMeasurer = {
      async measure() {
        throw new ResumeFitMeasureError("intentional failure for test");
      },
    };
    const service = new ResumeFitService(failing);
    await expect(
      service.measure({ html: "", templateId: "one-page-modern", density: "standard" }),
    ).rejects.toBeInstanceOf(ResumeFitMeasureError);
  });
});
