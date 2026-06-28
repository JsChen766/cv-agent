import { describe, expect, it } from "vitest";
import { ResumeLayoutComposer } from "../src/exports/layout/ResumeLayoutComposer.js";
import { A4_ONE_PAGE_SPEC } from "../src/exports/layout/PageSpec.js";
import type { ResumeLayoutReport, ResumeLayoutSession } from "../src/exports/layout/ResumeLayoutOracle.js";
import { onePageModernTemplate } from "../src/exports/templates/onePageModernTemplate.js";
import type { ProductResumeDetail, ProductResumeItem } from "../src/product/types.js";

function buildItem(over: Partial<ProductResumeItem> = {}): ProductResumeItem {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: over.id ?? "item-1",
    resumeId: over.resumeId ?? "resume-1",
    userId: over.userId ?? "user-1",
    sourceExperienceId: over.sourceExperienceId,
    sourceVariantId: over.sourceVariantId,
    sourceArtifactId: over.sourceArtifactId,
    sectionType: over.sectionType ?? "experience",
    title: over.title ?? "Data Analyst",
    contentSnapshot: over.contentSnapshot ?? "Data Analyst",
    orderIndex: over.orderIndex ?? 0,
    hidden: over.hidden ?? false,
    pinned: over.pinned ?? false,
    metadata: over.metadata ?? {},
    createdAt: over.createdAt ?? now,
    updatedAt: over.updatedAt ?? now,
  };
}

function buildResume(items: ProductResumeItem[]): ProductResumeDetail {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "resume-1",
    userId: "user-1",
    title: "Candidate",
    targetRole: "Data Analyst",
    status: "draft",
    createdAt: now,
    updatedAt: now,
    items,
  };
}

function reportFromHtml(html: string): ResumeLayoutReport {
  const bulletTexts = Array.from(html.matchAll(/<li[^>]*data-bullet-id="([^"]+)"[^>]*>(.*?)<\/li>/g))
    .map((match) => ({
      bulletId: match[1]!,
      text: match[2]!.replace(/<[^>]+>/g, ""),
    }));
  const minRequired = Math.round(A4_ONE_PAGE_SPEC.contentWidthPx * A4_ONE_PAGE_SPEC.bulletMinLineWidthRatio);
  const bulletLayouts = bulletTexts.map(({ bulletId, text }) => {
    const widths = [Math.min(700, Math.max(120, text.length * 8))];
    const passesWidthRule = widths.length > 0
      && widths.length <= A4_ONE_PAGE_SPEC.maxBulletLines
      && widths.every((width) => width >= minRequired);
    return {
      bulletId,
      lineCount: 1,
      lineWidthsPx: widths,
      minRequiredLineWidthPx: minRequired,
      passesWidthRule,
      text,
    };
  });
  const invalidBullets = bulletLayouts.filter((item) => !item.passesWidthRule);
  const overflows = html.includes("OVERFLOW_ONLY_TOKEN");
  return {
    layoutSessionId: "test-layout",
    templateId: "one-page-modern",
    density: "standard",
    targetPages: 1,
    contentWidthPx: A4_ONE_PAGE_SPEC.contentWidthPx,
    usableHeightPx: A4_ONE_PAGE_SPEC.usableHeightPx,
    contentHeightPx: overflows ? A4_ONE_PAGE_SPEC.usableHeightPx + 80 : 120 + bulletLayouts.length * 40,
    remainingHeightPx: overflows ? 0 : 400,
    overflowPx: overflows ? 80 : 0,
    fitsPage: !overflows,
    bulletMinLineWidthRatio: A4_ONE_PAGE_SPEC.bulletMinLineWidthRatio,
    maxBulletLines: A4_ONE_PAGE_SPEC.maxBulletLines,
    passesBulletWidthRule: invalidBullets.length === 0,
    bulletLayouts,
    invalidBullets,
    sectionLayouts: [],
    itemLayouts: [],
    measuredAt: "2026-01-01T00:00:00.000Z",
    measurer: "heuristic",
  };
}

describe("ResumeLayoutComposer", () => {
  it("keeps only bullets that fit the measured one-page layout", async () => {
    const session: ResumeLayoutSession = {
      measure: async (html) => reportFromHtml(html),
      close: async () => {},
    };
    const sessions = {
      withSession: async <T,>(
        _input: { layoutSessionId: string; templateId: string; density: string },
        fn: (session: ResumeLayoutSession) => Promise<T>,
      ) => fn(session),
    };
    const composer = new ResumeLayoutComposer(sessions);
    const resume = buildResume([
      buildItem({
        id: "exp-1",
        contentSnapshot: [
          "Data Analyst · WEEX · 2026.01 - 2026.04",
          "- OVERFLOW_ONLY_TOKEN makes this candidate exceed the one page layout budget",
          "- Coordinated product, risk, and operations teams to standardize 20+ core metrics in 2 weeks, reducing repeated communication across 30+ business stakeholders",
        ].join("\n"),
        metadata: { itemId: "doc-exp-1", bulletIds: ["b-short", "b-good"] },
      }),
    ]);

    const result = await composer.compose({
      layoutSessionId: "test-layout",
      resume,
      templateId: "one-page-modern",
      density: "standard",
      renderHtml: (candidate) => onePageModernTemplate().render({ resume: candidate }),
    });

    expect(result.resume.items).toHaveLength(1);
    expect(result.resume.items[0].contentSnapshot).not.toContain("OVERFLOW_ONLY_TOKEN");
    expect(result.resume.items[0].contentSnapshot).toContain("standardize 20+ core metrics");
    expect(result.report.passesBulletWidthRule).toBe(true);
    expect(result.actions.some((action) => action.type === "reject_bullet")).toBe(true);
  });

  it("rejects career bullets whose natural line width is below the two-thirds threshold", async () => {
    const session: ResumeLayoutSession = {
      measure: async (html) => reportFromHtml(html),
      close: async () => {},
    };
    const sessions = {
      withSession: async <T,>(
        _input: { layoutSessionId: string; templateId: string; density: string },
        fn: (session: ResumeLayoutSession) => Promise<T>,
      ) => fn(session),
    };
    const composer = new ResumeLayoutComposer(sessions);
    const resume = buildResume([
      buildItem({
        id: "exp-1",
        contentSnapshot: [
          "Data Analyst · WEEX · 2026.01 - 2026.04",
          "- Short bullet",
          "- Coordinated product, risk, and operations teams to standardize 20+ core metrics in 2 weeks, reducing repeated communication across 30+ business stakeholders",
        ].join("\n"),
        metadata: { itemId: "doc-exp-1", bulletIds: ["b-short", "b-good"] },
      }),
    ]);

    const result = await composer.compose({
      layoutSessionId: "test-layout",
      resume,
      templateId: "one-page-modern",
      density: "standard",
      renderHtml: (candidate) => onePageModernTemplate().render({ resume: candidate }),
    });

    expect(result.resume.items[0].contentSnapshot).not.toContain("Short bullet");
    expect(result.resume.items[0].contentSnapshot).toContain("standardize 20+ core metrics");
    expect(result.actions).toContainEqual(expect.objectContaining({
      type: "reject_bullet",
      itemId: "exp-1",
      bulletText: "Short bullet",
    }));
  });

  it("does not create shortened CJK variants that end as hard-cut fragments", async () => {
    const session: ResumeLayoutSession = {
      measure: async (html) => reportFromHtml(html),
      close: async () => {},
    };
    const sessions = {
      withSession: async <T,>(
        _input: { layoutSessionId: string; templateId: string; density: string },
        fn: (session: ResumeLayoutSession) => Promise<T>,
      ) => fn(session),
    };
    const composer = new ResumeLayoutComposer(sessions);
    const resume = buildResume([
      buildItem({
        id: "exp-1",
        contentSnapshot: [
          "数据分析实习生 · WEEX · 2026.01 - 2026.04",
          "- 负责300万+条关键词库与语料库管理，设计标准化标签体系，数据检索与调用效率提升40%以上，数据清洗与预处理：处理30万+条语料库，采用去重方法提升有效数据占比，OVERFLOW_ONLY_TOKEN",
        ].join("\n"),
        metadata: { itemId: "doc-exp-1", bulletIds: ["b-long"] },
      }),
    ]);

    const result = await composer.compose({
      layoutSessionId: "test-layout",
      resume,
      templateId: "one-page-modern",
      density: "standard",
      renderHtml: (candidate) => onePageModernTemplate().render({ resume: candidate }),
    });

    const snapshot = result.resume.items[0].contentSnapshot;
    expect(snapshot).not.toContain("OVERFLOW_ONLY_TOKEN");
    expect(snapshot).not.toMatch(/处理\d{1,2}$|[:：]\s*[^，。；;、,]{0,8}$/u);
    expect(snapshot).toContain("数据检索与调用效率提升40%以上");
  });
});
