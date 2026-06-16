import { describe, expect, it } from "vitest";
import { ResumeQualityService } from "../src/exports/ResumeQualityService.js";
import type { ProductResumeDetail, ProductResumeItem, ProductJDRecord } from "../src/product/types.js";
import type { ResumeFitReport } from "../src/exports/ResumeFitService.js";
import type { ResumeCompressionReport } from "../src/exports/ResumeCompressionService.js";
import type { ResumeFitEditorReport } from "../src/exports/ResumeLLMFitEditor.js";

function makeBullet(id: string, text: string) { return { id, text }; }

function makeItem(id: string, bullets: { id: string; text: string }[], extras: Partial<ProductResumeItem> & { metadata?: Record<string, unknown> } = {}): ProductResumeItem {
  const baseMetadata = {
    itemId: id,
    bulletIds: bullets.map((b) => b.id),
    bulletTexts: bullets.reduce<Record<string, string>>((acc, b) => { acc[b.id] = b.text; return acc; }, {}),
    relevanceScore: 0.7,
    ...(extras.metadata ?? {}),
  };
  return {
    id, resumeId: "r-1", userId: "u-1",
    sectionType: "experience",
    title: "Engineer",
    contentSnapshot: bullets.map((b) => `- ${b.text}`).join("\n"),
    pinned: false, hidden: false,
    createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z",
    ...extras, metadata: baseMetadata,
  } as unknown as ProductResumeItem;
}

function makeResume(items: ProductResumeItem[], jdId?: string): ProductResumeDetail {
  return { id: "r-1", userId: "u-1", title: "T", status: "draft",
    createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z",
    jdId, items } as ProductResumeDetail;
}

function makeFit(extras: Partial<ResumeFitReport> = {}): ResumeFitReport {
  return { targetPages: 1, estimatedPages: 1, overflowPx: 0, underflowPx: 80,
    contentHeightPx: 900, pageUsableHeightPx: 987,
    templateId: "one-page-modern", density: "standard",
    measurer: "heuristic", measuredAt: "2025-01-01T00:00:00Z", ...extras };
}

const VANILLA = "Built React dashboard for sales team and shipped weekly releases.";
const METRIC = "Reduced page load time by 35% across 12 pages.";
const HYPE = "Achieved 100% perfect launch and became the industry-first solution overnight.";
const ZH = "在三个月内将转化率提升了 25%，覆盖 5 个核心场景。";

describe("ResumeQualityService.evaluate (deterministic)", () => {
  it("baseline healthy resume reports all dimensions and no critical risks", () => {
    const items = [makeItem("i-1", [makeBullet("b-1", METRIC), makeBullet("b-2", VANILLA)],
      { sourceExperienceId: "exp-1", metadata: { sourceExperienceId: "exp-1", bulletEvidence: { "b-1": "exp-1", "b-2": "exp-1" }, relevanceScore: 0.8 } })];
    const svc = new ResumeQualityService();
    const r = svc.evaluate({ resume: makeResume(items), items, density: "standard", fitReport: makeFit() });
    expect(r.overallScore).toBeGreaterThanOrEqual(60);
    expect(r.overallScore).toBeLessThanOrEqual(100);
    expect(r.authenticityScore).toBeGreaterThanOrEqual(70);
    expect(r.evidenceScore).toBeGreaterThanOrEqual(70);
    expect(r.layoutScore).toBeGreaterThanOrEqual(70);
    expect(r.hasCriticalRisks).toBe(false);
    expect(Array.isArray(r.risks)).toBe(true);
    expect(Array.isArray(r.suggestions)).toBe(true);
    expect(Array.isArray(r.unsupportedClaims)).toBe(true);
    expect(typeof r.generatedAt).toBe("string");
  });

  describe("authenticity", () => {
    it("flags hyperbolic bullets without evidence as critical", () => {
      const items = [makeItem("i-1", [makeBullet("b-1", HYPE)], { metadata: { relevanceScore: 0.9 } })];
      const r = new ResumeQualityService().evaluate({ resume: makeResume(items), items, density: "standard", fitReport: makeFit() });
      expect(r.unsupportedClaims).toContain(HYPE);
      expect(r.hasCriticalRisks).toBe(true);
      const auth = r.risks.find((x) => x.dimension === "authenticity");
      expect(auth?.level).toBe("critical");
      expect(auth?.bulletId).toBe("b-1");
      expect(r.authenticityScore).toBeLessThan(70);
    });

    it("does NOT flag hyperbolic bullets when sourceExperienceId is present", () => {
      const items = [makeItem("i-1", [makeBullet("b-1", HYPE)], {
        sourceExperienceId: "exp-1",
        metadata: { sourceExperienceId: "exp-1", bulletEvidence: { "b-1": "exp-1" } },
      })];
      const r = new ResumeQualityService().evaluate({ resume: makeResume(items), items, density: "standard", fitReport: makeFit() });
      expect(r.unsupportedClaims.length).toBe(0);
      expect(r.hasCriticalRisks).toBe(false);
    });
  });

  describe("jd_match", () => {
    it("scores high when bullets cover JD keywords", () => {
      const items = [
        makeItem("i-1", [makeBullet("b-1", "Built React dashboard with TypeScript and PostgreSQL.")], { metadata: { sourceExperienceId: "e-1" } }),
        makeItem("i-2", [makeBullet("b-2", "Optimized GraphQL endpoints and improved CI/CD pipelines.")], { metadata: { sourceExperienceId: "e-2" } }),
      ];
      const jd: ProductJDRecord = { id: "j-1", userId: "u-1", title: "Senior",
        rawText: "Senior engineer skilled in React, TypeScript, PostgreSQL, GraphQL, and CI/CD pipelines.",
        createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z" };
      const r = new ResumeQualityService().evaluate({ resume: makeResume(items, "j-1"), items, density: "standard", fitReport: makeFit(), jd });
      expect(r.jdMatchScore).toBeGreaterThanOrEqual(70);
      expect(r.risks.find((x) => x.dimension === "jd_match" && x.level !== "low")).toBeUndefined();
    });

    it("flags low coverage when bullets ignore JD keywords", () => {
      const items = [makeItem("i-1", [makeBullet("b-1", "Walked the dog every morning and watered the plants.")], { metadata: {} })];
      const jd: ProductJDRecord = { id: "j-1", userId: "u-1", title: "Senior",
        rawText: "React, TypeScript, PostgreSQL, GraphQL, CI/CD experience needed.",
        createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z" };
      const r = new ResumeQualityService().evaluate({ resume: makeResume(items, "j-1"), items, density: "standard", fitReport: makeFit(), jd });
      expect(r.jdMatchScore).toBeLessThan(60);
      const jdRisk = r.risks.find((x) => x.dimension === "jd_match");
      expect(jdRisk).toBeDefined();
      expect(["medium", "high"]).toContain(jdRisk?.level);
    });

    it("returns neutral score when no JD is provided", () => {
      const items = [makeItem("i-1", [makeBullet("b-1", VANILLA)])];
      const r = new ResumeQualityService().evaluate({ resume: makeResume(items), items, density: "standard", fitReport: makeFit() });
      expect(r.jdMatchScore).toBeGreaterThanOrEqual(50);
      expect(r.jdMatchScore).toBeLessThanOrEqual(70);
      expect(r.risks.find((x) => x.dimension === "jd_match")).toBeUndefined();
    });
  });

  describe("evidence", () => {
    it("scores low when most bullets have no evidence", () => {
      const items = [makeItem("i-1", [makeBullet("b-1", VANILLA), makeBullet("b-2", METRIC), makeBullet("b-3", ZH)], { metadata: {} })];
      const r = new ResumeQualityService().evaluate({ resume: makeResume(items), items, density: "standard", fitReport: makeFit() });
      expect(r.evidenceScore).toBeLessThan(50);
      const ev = r.risks.find((x) => x.dimension === "evidence");
      expect(ev).toBeDefined();
      expect(["medium", "high"]).toContain(ev?.level);
    });

    it("scores high when bullets have evidence", () => {
      const items = [makeItem("i-1", [makeBullet("b-1", VANILLA), makeBullet("b-2", METRIC)],
        { sourceExperienceId: "e-1", metadata: { sourceExperienceId: "e-1", bulletEvidence: { "b-1": "e-1", "b-2": "e-1" } } })];
      const r = new ResumeQualityService().evaluate({ resume: makeResume(items), items, density: "standard", fitReport: makeFit() });
      expect(r.evidenceScore).toBeGreaterThanOrEqual(80);
    });
  });

  describe("metric", () => {
    it("emits metric suggestion when fewer than 30% of bullets contain numbers", () => {
      const items = [makeItem("i-1", [
        makeBullet("b-1", "Wrote documentation for the team."),
        makeBullet("b-2", "Refactored legacy modules to improve readability."),
        makeBullet("b-3", "Mentored interns."),
      ])];
      const r = new ResumeQualityService().evaluate({ resume: makeResume(items), items, density: "standard", fitReport: makeFit() });
      expect(r.metricScore).toBeLessThan(60);
      expect(r.suggestions.find((s) => s.dimension === "metric")).toBeDefined();
    });

    it("does NOT emit metric suggestion when bullets are metric-rich", () => {
      const items = [makeItem("i-1", [
        makeBullet("b-1", METRIC),
        makeBullet("b-2", "Onboarded 10 new clients within 6 weeks."),
        makeBullet("b-3", ZH),
      ])];
      const r = new ResumeQualityService().evaluate({ resume: makeResume(items), items, density: "standard", fitReport: makeFit() });
      expect(r.metricScore).toBeGreaterThanOrEqual(70);
      expect(r.suggestions.find((s) => s.dimension === "metric")).toBeUndefined();
    });
  });

  describe("expression", () => {
    it("emits suggestions for very short or very long bullets", () => {
      const items = [makeItem("i-1", [
        makeBullet("b-1", "Did stuff."),
        makeBullet("b-2", "x".repeat(260)),
      ])];
      const r = new ResumeQualityService().evaluate({ resume: makeResume(items), items, density: "standard", fitReport: makeFit() });
      const exprSuggestions = r.suggestions.filter((s) => s.dimension === "expression");
      expect(exprSuggestions.length).toBeGreaterThanOrEqual(2);
      const targetIds = exprSuggestions.map((s) => s.bulletId);
      expect(targetIds).toContain("b-1");
      expect(targetIds).toContain("b-2");
    });
  });

  describe("layout", () => {
    it("emits a high layout risk when overflow remains after compression and edit fallback", () => {
      const items = [makeItem("i-1", [makeBullet("b-1", VANILLA)])];
      const fit = makeFit({ overflowPx: 240, estimatedPages: 2, underflowPx: 0 });
      const compression: ResumeCompressionReport = {
        applied: true,
        actions: [],
        iterations: 4,
        initialEstimatedPages: 2,
        finalEstimatedPages: 2,
        initialOverflowPx: 320,
        finalOverflowPx: 240,
        densityBefore: "standard",
        densityAfter: "compact",
        stillOverflowing: true,
        reason: "no_more_strategies",
      };
      const edit: ResumeFitEditorReport = {
        applied: false, fallback: true, trigger: "still_overflowing", reason: "all_rejected",
        initialEstimatedPages: 2, finalEstimatedPages: 2,
        initialOverflowPx: 240, finalOverflowPx: 240,
        initialUnderflowPx: 0, finalUnderflowPx: 0,
        actions: [], measuredAt: "2025-01-01T00:00:00Z",
      };
      const r = new ResumeQualityService().evaluate({ resume: makeResume(items), items, density: "compact", fitReport: fit, compressionReport: compression, editReport: edit });
      expect(r.layoutScore).toBeLessThan(50);
      const layout = r.risks.find((x) => x.dimension === "layout");
      expect(layout).toBeDefined();
      expect(["high", "critical"]).toContain(layout?.level);
    });

    it("emits a medium layout suggestion when underflow is large and editor did not run", () => {
      const items = [makeItem("i-1", [makeBullet("b-1", VANILLA)])];
      const fit = makeFit({ overflowPx: 0, underflowPx: 320, contentHeightPx: 600, pageUsableHeightPx: 987 });
      const r = new ResumeQualityService().evaluate({ resume: makeResume(items), items, density: "standard", fitReport: fit });
      const layoutSuggestion = r.suggestions.find((s) => s.dimension === "layout");
      expect(layoutSuggestion).toBeDefined();
    });

    it("does NOT emit a layout risk when the page is balanced", () => {
      const items = [makeItem("i-1", [makeBullet("b-1", VANILLA)])];
      const r = new ResumeQualityService().evaluate({ resume: makeResume(items), items, density: "standard", fitReport: makeFit({ overflowPx: 0, underflowPx: 80 }) });
      expect(r.layoutScore).toBeGreaterThanOrEqual(80);
      expect(r.risks.find((x) => x.dimension === "layout")).toBeUndefined();
    });
  });

  it("never throws when items is empty", () => {
    const r = new ResumeQualityService().evaluate({ resume: makeResume([]), items: [], density: "standard", fitReport: makeFit() });
    expect(r.overallScore).toBeGreaterThanOrEqual(0);
    expect(r.overallScore).toBeLessThanOrEqual(100);
  });
});