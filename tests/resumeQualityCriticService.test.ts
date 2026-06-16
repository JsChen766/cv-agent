import { describe, expect, it } from "vitest";
import {
  ResumeQualityCriticService,
  buildCriticBulletProvenance,
  mergeCriticReview,
  type ResumeQualityCriticChatFn,
} from "../src/exports/ResumeQualityCriticService.js";
import { ResumeQualityService } from "../src/exports/ResumeQualityService.js";
import type { ProductResumeDetail, ProductResumeItem, ProductJDRecord } from "../src/product/types.js";
import type { ResumeFitReport } from "../src/exports/ResumeFitService.js";

const PROMPT = "stub-system-prompt";
const HYPE = "Achieved 100% perfect launch and became the industry-first solution overnight.";
const METRIC = "Reduced page load time by 35% across 12 pages.";

function makeBullet(id: string, text: string) { return { id, text }; }

function makeItem(
  id: string,
  bullets: { id: string; text: string }[],
  extras: Partial<ProductResumeItem> & { metadata?: Record<string, unknown> } = {},
): ProductResumeItem {
  const baseMetadata = {
    itemId: id,
    bulletIds: bullets.map((b) => b.id),
    bulletTexts: bullets.reduce<Record<string, string>>((acc, b) => { acc[b.id] = b.text; return acc; }, {}),
    relevanceScore: 0.9,
    ...(extras.metadata ?? {}),
  };
  return {
    id,
    resumeId: "r-1",
    userId: "u-1",
    sectionType: "experience",
    title: "Engineer",
    contentSnapshot: bullets.map((b) => `- ${b.text}`).join("\n"),
    pinned: false,
    hidden: false,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...extras,
    metadata: baseMetadata,
  } as unknown as ProductResumeItem;
}

function makeResume(items: ProductResumeItem[], jdId?: string): ProductResumeDetail {
  return {
    id: "r-1", userId: "u-1", title: "T", status: "draft",
    createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z",
    jdId, items,
  } as ProductResumeDetail;
}

function makeFit(extras: Partial<ResumeFitReport> = {}): ResumeFitReport {
  return {
    targetPages: 1, estimatedPages: 1, overflowPx: 0, underflowPx: 80,
    contentHeightPx: 900, pageUsableHeightPx: 987,
    templateId: "one-page-modern", density: "standard",
    measurer: "heuristic", measuredAt: "2025-01-01T00:00:00Z", ...extras,
  };
}

function evaluateBaseline(items: ProductResumeItem[], jd?: ProductJDRecord) {
  const svc = new ResumeQualityService();
  return svc.evaluate({ resume: makeResume(items, jd?.id), items, density: "standard", fitReport: makeFit(), jd });
}

function chatReturning(payload: unknown): ResumeQualityCriticChatFn {
  return async () => ({ content: typeof payload === "string" ? payload : JSON.stringify(payload) });
}

describe("ResumeQualityCriticService.review (Hybrid Critic)", () => {
  it("returns fallback when no chat callback is configured", async () => {
    const items = [makeItem("i-1", [makeBullet("b-1", METRIC)], { metadata: { sourceExperienceId: "e-1" } })];
    const ruleReport = evaluateBaseline(items);
    const critic = new ResumeQualityCriticService({ prompt: PROMPT });
    const review = await critic.review({ resume: makeResume(items), items, ruleReport, fitReport: makeFit() });
    expect(review.applied).toBe(false);
    expect(review.fallback).toBe(true);
    expect(review.reason).toBe("no_model_client");
    expect(review.authenticityRisks).toEqual([]);
    expect(review.rewriteSuggestions).toEqual([]);
  });

  it("happy path: stub returns valid JSON, fields are surfaced", async () => {
    const items = [makeItem("i-1", [makeBullet("b-1", METRIC)], { metadata: { sourceExperienceId: "e-1" } })];
    const ruleReport = evaluateBaseline(items);
    const stubChat = chatReturning({
      semanticJdMatchScore: 78,
      expressionQualityScore: 64,
      authenticityReview: { risks: [{ level: "low", message: "Bullet is concise.", itemId: "i-1", bulletId: "b-1", evidenceMissing: false }] },
      rewriteSuggestions: [{ itemId: "i-1", bulletId: "b-1", before: METRIC, suggestion: "Cut page load time 35% across 12 pages.", reason: "More concise." }],
      missingEvidence: [],
      overallComment: "Looks solid.",
    });
    const critic = new ResumeQualityCriticService({ prompt: PROMPT, chat: stubChat });
    const review = await critic.review({ resume: makeResume(items), items, ruleReport, fitReport: makeFit() });
    expect(review.applied).toBe(true);
    expect(review.fallback).toBe(false);
    expect(review.reason).toBe("ok");
    expect(review.semanticJdMatchScore).toBe(78);
    expect(review.expressionQualityScore).toBe(64);
    expect(review.authenticityRisks).toHaveLength(1);
    expect(review.authenticityRisks[0]).toMatchObject({ level: "low", itemId: "i-1", bulletId: "b-1", evidenceMissing: false });
    expect(review.rewriteSuggestions).toHaveLength(1);
    expect(review.rewriteSuggestions[0].suggestion).toContain("Cut page load time");
    expect(review.overallComment).toBe("Looks solid.");
    expect(review.rejectedReferences).toBeUndefined();
  });

  it("invalid JSON yields schema_invalid fallback", async () => {
    const items = [makeItem("i-1", [makeBullet("b-1", METRIC)], { metadata: { sourceExperienceId: "e-1" } })];
    const ruleReport = evaluateBaseline(items);
    const critic = new ResumeQualityCriticService({ prompt: PROMPT, chat: chatReturning("this is not json {{") });
    const review = await critic.review({ resume: makeResume(items), items, ruleReport, fitReport: makeFit() });
    expect(review.applied).toBe(false);
    expect(review.fallback).toBe(true);
    expect(review.reason).toBe("schema_invalid");
    expect(review.authenticityRisks).toEqual([]);
  });

  it("off-schema JSON yields schema_invalid fallback", async () => {
    const items = [makeItem("i-1", [makeBullet("b-1", METRIC)], { metadata: { sourceExperienceId: "e-1" } })];
    const ruleReport = evaluateBaseline(items);
    const critic = new ResumeQualityCriticService({
      prompt: PROMPT,
      chat: chatReturning({ semanticJdMatchScore: "high", authenticityReview: { risks: [{ level: "panic", message: "x" }] } }),
    });
    const review = await critic.review({ resume: makeResume(items), items, ruleReport, fitReport: makeFit() });
    expect(review.applied).toBe(false);
    expect(review.reason).toBe("schema_invalid");
  });

  it("model errors are caught and surfaced as model_error fallback", async () => {
    const items = [makeItem("i-1", [makeBullet("b-1", METRIC)], { metadata: { sourceExperienceId: "e-1" } })];
    const ruleReport = evaluateBaseline(items);
    const critic = new ResumeQualityCriticService({ prompt: PROMPT, chat: async () => { throw new Error("boom"); } });
    const review = await critic.review({ resume: makeResume(items), items, ruleReport, fitReport: makeFit() });
    expect(review.applied).toBe(false);
    expect(review.fallback).toBe(true);
    expect(review.reason).toBe("model_error");
    expect(review.llmReason).toContain("boom");
  });
});
describe("ResumeQualityCriticService ¡ª ID provenance & sanitization", () => {
  it("rejects references to itemId/bulletId not in the input snapshot", async () => {
    const items = [makeItem("i-1", [makeBullet("b-1", METRIC)], { metadata: { sourceExperienceId: "e-1" } })];
    const ruleReport = evaluateBaseline(items);
    const critic = new ResumeQualityCriticService({
      prompt: PROMPT,
      chat: chatReturning({
        authenticityReview: {
          risks: [
            { level: "high", message: "Risk on a real bullet.", itemId: "i-1", bulletId: "b-1" },
            { level: "high", message: "Risk on a fake bullet.", itemId: "i-1", bulletId: "b-NOPE" },
            { level: "high", message: "Risk on a fake item.", itemId: "i-NOPE", bulletId: null },
          ],
        },
        rewriteSuggestions: [
          { itemId: "i-1", bulletId: "b-NOPE", before: null, suggestion: "Improve.", reason: "Test." },
        ],
        missingEvidence: [
          { bulletId: "b-NOPE-2", claim: "Some claim", reason: "No source" },
          { bulletId: "b-1", claim: "Real claim", reason: "Just testing" },
        ],
      }),
    });
    const review = await critic.review({ resume: makeResume(items), items, ruleReport, fitReport: makeFit() });
    expect(review.applied).toBe(true);
    expect(review.authenticityRisks).toHaveLength(1);
    expect(review.authenticityRisks[0].bulletId).toBe("b-1");
    expect(review.rewriteSuggestions).toHaveLength(0);
    expect(review.missingEvidence).toHaveLength(1);
    expect(review.missingEvidence[0].bulletId).toBe("b-1");
    expect(review.rejectedReferences).toBeDefined();
    const kinds = new Set(review.rejectedReferences!.map((r) => r.kind));
    expect(kinds.has("risk")).toBe(true);
    expect(kinds.has("suggestion")).toBe(true);
    expect(kinds.has("missingEvidence")).toBe(true);
  });

  it("sanitizes rewrite suggestions: strips bullet markers, collapses whitespace, trims length", async () => {
    const items = [makeItem("i-1", [makeBullet("b-1", METRIC)], { metadata: { sourceExperienceId: "e-1" } })];
    const ruleReport = evaluateBaseline(items);
    const long = "X".repeat(500);
    const critic = new ResumeQualityCriticService({
      prompt: PROMPT,
      chat: chatReturning({
        authenticityReview: { risks: [] },
        rewriteSuggestions: [
          { itemId: "i-1", bulletId: "b-1", before: METRIC, suggestion: "  - \tImproved   metric\n strongly  ", reason: "Cleaner phrasing." },
          { itemId: "i-1", bulletId: "b-1", before: METRIC, suggestion: long, reason: "Length test." },
        ],
        missingEvidence: [],
      }),
    });
    const review = await critic.review({ resume: makeResume(items), items, ruleReport, fitReport: makeFit() });
    expect(review.applied).toBe(true);
    expect(review.rewriteSuggestions).toHaveLength(2);
    expect(review.rewriteSuggestions[0].suggestion).toBe("Improved metric strongly");
    expect(review.rewriteSuggestions[0].suggestion.startsWith("- ")).toBe(false);
    expect(review.rewriteSuggestions[1].suggestion.length).toBeLessThanOrEqual(240);
  });
});

describe("mergeCriticReview ¡ª hasCriticalRisks merge rule", () => {
  it("rule-layer critical risk keeps hasCriticalRisks=true even without LLM corroboration", async () => {
    const items = [makeItem("i-1", [makeBullet("b-1", HYPE)], { metadata: { relevanceScore: 0.95 } })];
    const ruleReport = evaluateBaseline(items);
    expect(ruleReport.hasCriticalRisks).toBe(true);
    const critic = new ResumeQualityCriticService({ prompt: PROMPT, chat: chatReturning({ authenticityReview: { risks: [] }, rewriteSuggestions: [], missingEvidence: [] }) });
    const review = await critic.review({ resume: makeResume(items), items, ruleReport, fitReport: makeFit() });
    const merged = mergeCriticReview(ruleReport, review, buildCriticBulletProvenance(items, ruleReport));
    expect(merged.hasCriticalRisks).toBe(true);
    expect(merged.criticReview).toBeDefined();
    expect(merged.criticReview!.applied).toBe(true);
  });

  it("LLM-only critical risk on a bullet that IS in unsupportedClaims promotes hasCriticalRisks=true", async () => {
    const items = [makeItem("i-1", [makeBullet("b-1", HYPE)], { metadata: { relevanceScore: 0.95 } })];
    const ruleReport = evaluateBaseline(items);
    const review = {
      applied: true, fallback: false, reason: "ok" as const,
      authenticityRisks: [{ id: "x", level: "critical" as const, message: "Unsupported.", itemId: "i-1", bulletId: "b-1", evidenceMissing: true }],
      rewriteSuggestions: [], missingEvidence: [], generatedAt: "2025-01-01T00:00:00Z",
    };
    const merged = mergeCriticReview(ruleReport, review, buildCriticBulletProvenance(items, ruleReport));
    expect(merged.hasCriticalRisks).toBe(true);
    expect(merged.criticReview).toBe(review);
  });

  it("LLM-only critical risk on a bullet WITH evidence and NOT in unsupportedClaims does NOT promote hasCriticalRisks", async () => {
    const items = [makeItem("i-1", [makeBullet("b-1", METRIC)], { metadata: { sourceExperienceId: "e-1", bulletEvidence: { "b-1": "e-1" } } })];
    const ruleReport = evaluateBaseline(items);
    expect(ruleReport.hasCriticalRisks).toBe(false);
    const review = {
      applied: true, fallback: false, reason: "ok" as const,
      authenticityRisks: [{ id: "x", level: "critical" as const, message: "Stylistic only.", itemId: "i-1", bulletId: "b-1", evidenceMissing: false }],
      rewriteSuggestions: [], missingEvidence: [], generatedAt: "2025-01-01T00:00:00Z",
    };
    const merged = mergeCriticReview(ruleReport, review, buildCriticBulletProvenance(items, ruleReport));
    expect(merged.hasCriticalRisks).toBe(false);
    expect(merged.criticReview).toBe(review);
  });

  it("attaches criticReview even when fallback=true (offline / schema_invalid)", async () => {
    const items = [makeItem("i-1", [makeBullet("b-1", METRIC)], { metadata: { sourceExperienceId: "e-1" } })];
    const ruleReport = evaluateBaseline(items);
    const review = {
      applied: false, fallback: true, reason: "no_model_client" as const,
      authenticityRisks: [], rewriteSuggestions: [], missingEvidence: [], generatedAt: "2025-01-01T00:00:00Z",
    };
    const merged = mergeCriticReview(ruleReport, review, buildCriticBulletProvenance(items, ruleReport));
    expect(merged.criticReview).toBe(review);
    expect(merged.hasCriticalRisks).toBe(ruleReport.hasCriticalRisks);
  });
});