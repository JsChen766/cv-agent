import { describe, expect, it } from "vitest";
import { EvidenceCompletenessGuard } from "../src/knowledge/ingestion/EvidenceCompletenessGuard.js";

const RAW_TEXT = [
  "As a Senior Frontend Engineer at Acme Corp, I led a React and TypeScript design system project for 12 product teams.",
  "Built an accessible component library with WCAG practices and shared API integration patterns.",
  "Reduced bundle size by 40% through performance optimization, tree-shaking, and lazy loading.",
].join("\n");

describe("EvidenceCompletenessGuard", () => {
  it("splits multiline rawText into source sentences", () => {
    const guard = new EvidenceCompletenessGuard();

    const result = guard.complete({
      rawText: RAW_TEXT,
      evidenceExcerpts: [],
    });

    expect(result.evidenceExcerpts).toEqual([
      "As a Senior Frontend Engineer at Acme Corp, I led a React and TypeScript design system project for 12 product teams.",
      "Built an accessible component library with WCAG practices and shared API integration patterns.",
      "Reduced bundle size by 40% through performance optimization, tree-shaking, and lazy loading.",
    ]);
  });

  it("adds missing important source sentence when agent evidenceExcerpts omit it", () => {
    const guard = new EvidenceCompletenessGuard();

    const result = guard.complete({
      rawText: RAW_TEXT,
      evidenceExcerpts: [
        "As a Senior Frontend Engineer at Acme Corp, I led a React and TypeScript design system project for 12 product teams.",
        "Reduced bundle size by 40% through performance optimization, tree-shaking, and lazy loading.",
      ],
    });

    expect(result.evidenceExcerpts).toContain(
      "Built an accessible component library with WCAG practices and shared API integration patterns.",
    );
    expect(result.addedExcerpts).toEqual([
      "Built an accessible component library with WCAG practices and shared API integration patterns.",
    ]);
  });

  it("does not duplicate already covered evidence", () => {
    const guard = new EvidenceCompletenessGuard();

    const result = guard.complete({
      rawText: RAW_TEXT,
      evidenceExcerpts: [
        "Built an accessible component library with WCAG practices and shared API integration patterns.",
      ],
    });

    expect(
      result.evidenceExcerpts.filter((excerpt) => excerpt.includes("accessible component library")),
    ).toHaveLength(1);
  });

  it("does not add unimportant short sentences", () => {
    const guard = new EvidenceCompletenessGuard();

    const result = guard.complete({
      rawText: "Ok.\nBuilt a React component library for product teams.",
      evidenceExcerpts: [],
    });

    expect(result.evidenceExcerpts).toEqual([
      "Built a React component library for product teams.",
    ]);
  });

  it("keeps result metric sentence with 40% when omitted", () => {
    const guard = new EvidenceCompletenessGuard();

    const result = guard.complete({
      rawText: RAW_TEXT,
      evidenceExcerpts: [
        "Built an accessible component library with WCAG practices and shared API integration patterns.",
      ],
    });

    expect(result.evidenceExcerpts).toContain(
      "Reduced bundle size by 40% through performance optimization, tree-shaking, and lazy loading.",
    );
  });

  it("keeps WCAG and API sentence when omitted", () => {
    const guard = new EvidenceCompletenessGuard();

    const result = guard.complete({
      rawText: RAW_TEXT,
      evidenceExcerpts: [
        "As a Senior Frontend Engineer at Acme Corp, I led a React and TypeScript design system project for 12 product teams.",
      ],
    });

    expect(result.evidenceExcerpts).toContain(
      "Built an accessible component library with WCAG practices and shared API integration patterns.",
    );
  });

  it("respects maxEvidenceExcerpts", () => {
    const guard = new EvidenceCompletenessGuard();

    const result = guard.complete({
      rawText: [
        RAW_TEXT,
        "Implemented reusable testing workflows with Vitest for frontend teams.",
        "Created API integration helpers for backend data flows.",
      ].join("\n"),
      evidenceExcerpts: [],
      maxEvidenceExcerpts: 3,
    });

    expect(result.evidenceExcerpts).toHaveLength(3);
    expect(result.droppedExcerpts.length).toBeGreaterThan(0);
  });

  it("does not treat a sentence with 40% as covered by evidence without 40%", () => {
    const guard = new EvidenceCompletenessGuard();

    const result = guard.complete({
      rawText: "Reduced bundle size by 40% through performance optimization.",
      evidenceExcerpts: ["Reduced bundle size through performance optimization."],
    });

    expect(result.evidenceExcerpts).toContain(
      "Reduced bundle size by 40% through performance optimization.",
    );
  });
});
