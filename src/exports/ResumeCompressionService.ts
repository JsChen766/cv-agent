import type { ProductResumeItem } from "../product/types.js";
import type { ResumeFitReport } from "./ResumeFitService.js";

const MAX_ITERATIONS = 6;
const SHORTEN_BULLET_TARGET_LENGTH = 140;
const SHORTEN_BULLET_MIN_LENGTH = 180;

export type ResumeCompressionAction =
  | { type: "drop_bullet"; itemId: string; bulletId?: string; bulletText: string; reason: "optional_low_relevance" | "low_relevance_overflow" }
  | { type: "shorten_bullet"; itemId: string; bulletId?: string; before: string; after: string }
  | { type: "merge_bullets"; itemId: string; bulletIds: string[]; mergedText: string }
  | { type: "hide_item"; itemId: string; sectionType: string; reason: "low_relevance" }
  | { type: "drop_density"; from: string; to: string };

export type ResumeCompressionReport = {
  applied: boolean;
  initialEstimatedPages: number;
  finalEstimatedPages: number;
  initialOverflowPx: number;
  finalOverflowPx: number;
  iterations: number;
  actions: ResumeCompressionAction[];
  densityBefore: string;
  densityAfter: string;
  stillOverflowing: boolean;
  reason: "overflow_resolved" | "no_more_strategies" | "iteration_limit";
};

export type ResumeCompressionMeasureFn = (items: ProductResumeItem[], density: string) => Promise<ResumeFitReport>;

export type ResumeCompressionInput = {
  items: ProductResumeItem[];
  density: string;
  initialFitReport: ResumeFitReport;
  measure: ResumeCompressionMeasureFn;
};

export type ResumeCompressionResult = {
  items: ProductResumeItem[];
  density: string;
  fitReport: ResumeFitReport;
  compressionReport: ResumeCompressionReport;
};

/**
 * Phase 6 Fit Engine v2: rule-based compression for one-page resumes.
 *
 * When `ResumeFitService` reports that the rendered resume overflows one
 * A4 page on the `one-page-modern` template, this service walks a strict
 * priority of mutations on a deep clone of the resume's items:
 *
 *   1. drop bullets that are explicitly optional + low relevance
 *   2. shorten over-long bullets (truncate with ellipsis)
 *   3. hide the lowest-relevance non-pinned items
 *   4. downgrade density: standard -> compact
 *
 * After every mutation the service re-measures via the injected `measure`
 * callback. Up to a fixed iteration budget, it keeps trying mutations
 * until the resume fits OR no further strategy applies.
 *
 * The service is intentionally:
 *   - Pure: no DB writes, no LLM calls.
 *   - Pinned-safe: a `pinned` item or a bullet listed in
 *     `metadata.bulletPinned` is never removed/shortened.
 *   - Bounded: hard iteration cap so a misbehaving measurer cannot loop.
 *   - Warn-only: when nothing more can be done, returns
 *     `stillOverflowing: true` and lets the caller proceed with the
 *     export — Phase 6 inherits Phase 5's "never block on overflow"
 *     contract.
 */
export class ResumeCompressionService {
  public async compress(input: ResumeCompressionInput): Promise<ResumeCompressionResult> {
    const initial = input.initialFitReport;
    const initialEstimatedPages = initial.estimatedPages;
    const initialOverflowPx = initial.overflowPx;
    const eligible =
      initial.overflowPx > 0 &&
      initial.targetPages === 1 &&
      initial.templateId === "one-page-modern";

    if (!eligible) {
      return {
        items: input.items,
        density: input.density,
        fitReport: initial,
        compressionReport: {
          applied: false,
          initialEstimatedPages,
          finalEstimatedPages: initialEstimatedPages,
          initialOverflowPx,
          finalOverflowPx: initialOverflowPx,
          iterations: 0,
          actions: [],
          densityBefore: input.density,
          densityAfter: input.density,
          stillOverflowing: initialOverflowPx > 0,
          reason: "overflow_resolved",
        },
      };
    }

    let items = cloneItems(input.items);
    let density = input.density;
    const actions: ResumeCompressionAction[] = [];
    let currentReport = initial;
    let iterations = 0;

    while (currentReport.overflowPx > 0 && iterations < MAX_ITERATIONS) {
      const step = applyOneStrategy(items, density, actions);
      if (!step) break;
      items = step.items;
      density = step.density;
      iterations += 1;
      currentReport = await input.measure(items, density);
    }

    let reason: ResumeCompressionReport["reason"];
    if (currentReport.overflowPx === 0) reason = "overflow_resolved";
    else if (iterations >= MAX_ITERATIONS) reason = "iteration_limit";
    else reason = "no_more_strategies";

    return {
      items,
      density,
      fitReport: currentReport,
      compressionReport: {
        applied: true,
        initialEstimatedPages,
        finalEstimatedPages: currentReport.estimatedPages,
        initialOverflowPx,
        finalOverflowPx: currentReport.overflowPx,
        iterations,
        actions,
        densityBefore: input.density,
        densityAfter: density,
        stillOverflowing: currentReport.overflowPx > 0,
        reason,
      },
    };
  }
}

function cloneItems(items: ProductResumeItem[]): ProductResumeItem[] {
  return items.map((it) => ({
    ...it,
    metadata: cloneMetadata(it.metadata),
  }));
}

function cloneMetadata(meta: Record<string, unknown>): Record<string, unknown> {
  if (!meta) return {};
  // Shallow clone is enough for our keys: bulletIds/array, simple maps.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (Array.isArray(v)) out[k] = v.slice();
    else if (v && typeof v === "object") out[k] = { ...(v as Record<string, unknown>) };
    else out[k] = v;
  }
  return out;
}

type StepResult = { items: ProductResumeItem[]; density: string };

function applyOneStrategy(
  items: ProductResumeItem[],
  density: string,
  actions: ResumeCompressionAction[],
): StepResult | null {
  const optionalDrop = tryDropOptionalBullet(items);
  if (optionalDrop) {
    actions.push(optionalDrop);
    return { items, density };
  }

  const shorten = tryShortenLongBullet(items);
  if (shorten) {
    actions.push(shorten);
    return { items, density };
  }

  const hide = tryHideLowRelevanceItem(items);
  if (hide) {
    actions.push(hide);
    return { items, density };
  }

  if (density !== "compact") {
    const next = density === "comfortable" ? "standard" : "compact";
    actions.push({ type: "drop_density", from: density, to: next });
    return { items, density: next };
  }

  return null;
}

function tryDropOptionalBullet(items: ProductResumeItem[]): ResumeCompressionAction | null {
  let target: { item: ProductResumeItem; bulletIndex: number; bulletId: string; relevance: number } | null = null;
  for (const item of items) {
    if (item.hidden || item.pinned) continue;
    const meta = (item.metadata ?? {}) as Record<string, unknown>;
    const optionalMap = readBoolMap(meta, "bulletOptional");
    const pinnedMap = readBoolMap(meta, "bulletPinned");
    const relevanceMap = readNumberMap(meta, "bulletRelevance");
    const bulletIds = readStringArray(meta, "bulletIds");
    const parsed = parseSnapshot(item.contentSnapshot);
    for (let i = 0; i < parsed.bullets.length; i += 1) {
      const bid = bulletIds[i];
      if (!bid) continue;
      if (pinnedMap[bid]) continue;
      if (!optionalMap[bid]) continue;
      const rel = relevanceMap[bid] ?? 0;
      if (target === null || rel < target.relevance) {
        target = { item, bulletIndex: i, bulletId: bid, relevance: rel };
      }
    }
  }
  if (!target) return null;

  const { item, bulletIndex, bulletId } = target;
  const meta = (item.metadata ?? {}) as Record<string, unknown>;
  const bulletIds = readStringArray(meta, "bulletIds");
  const parsed = parseSnapshot(item.contentSnapshot);
  const bulletText = parsed.bullets[bulletIndex];
  parsed.bullets.splice(bulletIndex, 1);
  if (bulletIds.length) {
    const next = bulletIds.slice();
    next.splice(bulletIndex, 1);
    meta.bulletIds = next;
    item.metadata = meta;
  }
  item.contentSnapshot = renderSnapshot(parsed);
  return {
    type: "drop_bullet",
    itemId: readString(meta, "itemId") ?? item.id,
    bulletId,
    bulletText,
    reason: "optional_low_relevance",
  };
}

function tryShortenLongBullet(items: ProductResumeItem[]): ResumeCompressionAction | null {
  let bestItem: ProductResumeItem | null = null;
  let bestIndex = -1;
  let bestLen = SHORTEN_BULLET_MIN_LENGTH;
  for (const item of items) {
    if (item.hidden) continue;
    const meta = (item.metadata ?? {}) as Record<string, unknown>;
    const pinnedMap = readBoolMap(meta, "bulletPinned");
    const bulletIds = readStringArray(meta, "bulletIds");
    const parsed = parseSnapshot(item.contentSnapshot);
    for (let i = 0; i < parsed.bullets.length; i += 1) {
      const bid = bulletIds[i];
      if (bid && pinnedMap[bid]) continue;
      const len = parsed.bullets[i].length;
      if (len > bestLen) {
        bestLen = len;
        bestIndex = i;
        bestItem = item;
      }
    }
  }
  if (!bestItem || bestIndex < 0) return null;

  const meta = (bestItem.metadata ?? {}) as Record<string, unknown>;
  const bulletIds = readStringArray(meta, "bulletIds");
  const parsed = parseSnapshot(bestItem.contentSnapshot);
  const before = parsed.bullets[bestIndex];
  const after = truncateAtBoundary(before, SHORTEN_BULLET_TARGET_LENGTH);
  if (after === before) return null;
  parsed.bullets[bestIndex] = after;
  bestItem.contentSnapshot = renderSnapshot(parsed);
  return {
    type: "shorten_bullet",
    itemId: readString(meta, "itemId") ?? bestItem.id,
    bulletId: bulletIds[bestIndex],
    before,
    after,
  };
}

function tryHideLowRelevanceItem(items: ProductResumeItem[]): ResumeCompressionAction | null {
  let target: ProductResumeItem | null = null;
  let lowest = Number.POSITIVE_INFINITY;
  for (const item of items) {
    if (item.hidden || item.pinned) continue;
    const meta = (item.metadata ?? {}) as Record<string, unknown>;
    const rel = typeof meta.relevanceScore === "number" ? (meta.relevanceScore as number) : 0.5;
    if (rel < lowest) {
      lowest = rel;
      target = item;
    }
  }
  if (!target) return null;
  // Don't hide the only visible item — never empty the resume.
  const visibleCount = items.filter((i) => !i.hidden).length;
  if (visibleCount <= 1) return null;
  target.hidden = true;
  const meta = (target.metadata ?? {}) as Record<string, unknown>;
  return {
    type: "hide_item",
    itemId: readString(meta, "itemId") ?? target.id,
    sectionType: target.sectionType,
    reason: "low_relevance",
  };
}

type ParsedSnapshot = { header: string; bullets: string[]; trailing: string[] };

function parseSnapshot(snapshot: string): ParsedSnapshot {
  const lines = (snapshot ?? "").split(/\r?\n/);
  let header = "";
  const bullets: string[] = [];
  const trailing: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const m = /^[-\u2022*]\s+(.*)$/.exec(line);
    if (m) {
      bullets.push(m[1].trim());
      continue;
    }
    if (header === "" && bullets.length === 0) {
      header = line;
      continue;
    }
    trailing.push(line);
  }
  return { header, bullets, trailing };
}

function renderSnapshot(parsed: ParsedSnapshot): string {
  const lines: string[] = [];
  if (parsed.header) lines.push(parsed.header);
  for (const b of parsed.bullets) lines.push(`- ${b}`);
  for (const t of parsed.trailing) lines.push(t);
  return lines.join("\n");
}

function truncateAtBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const slice = text.slice(0, maxLen);
  // Cut at the last whitespace within the slice for a cleaner break.
  const ws = slice.lastIndexOf(" ");
  const cut = ws > maxLen * 0.6 ? slice.slice(0, ws) : slice;
  return `${cut.replace(/[\s,;:.\-\u2014\u2013]+$/u, "")}\u2026`;
}

function readBoolMap(meta: Record<string, unknown>, key: string): Record<string, boolean> {
  const v = meta[key];
  if (!v || typeof v !== "object") return {};
  const out: Record<string, boolean> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "boolean") out[k] = val;
  }
  return out;
}

function readNumberMap(meta: Record<string, unknown>, key: string): Record<string, number> {
  const v = meta[key];
  if (!v || typeof v !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "number" && Number.isFinite(val)) out[k] = val;
  }
  return out;
}

function readStringArray(meta: Record<string, unknown>, key: string): string[] {
  const v = meta[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function readString(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = meta?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

