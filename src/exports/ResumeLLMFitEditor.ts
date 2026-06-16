import { z } from "zod";
import type { ProductResumeItem } from "../product/types.js";
import { safeParseJsonOutput } from "../infrastructure/llm/JsonOutputParser.js";
import type { ResumeFitReport } from "./ResumeFitService.js";
import type { ResumeCompressionReport } from "./ResumeCompressionService.js";

const MAX_ACTIONS = 6;
const UNDERFLOW_TRIGGER_PX = 240;
const NEWTEXT_MAX_LEN = 240;
const SHORTEN_MIN_SAVING_CHARS = 15;

/**
 * Phase 7 Fit Engine v3: LLM-driven fit editor.
 *
 * Runs AFTER Phase 6 rule-based compression. Two trigger conditions:
 *   1. `still_overflowing` - Phase 6 ran and exhausted strategies but the
 *      resume still overflows one A4 page.
 *   2. `fill_underflow`   - the resume already fits and Phase 6 did NOT run,
 *      but the page has substantial empty space (`underflowPx` is large).
 *
 * The service is intentionally:
 *   - Pure: no DB writes, no template knowledge. Caller passes `measure()`
 *     callback that re-renders + re-measures with candidate items.
 *   - Schema-fenced: the LLM may only emit a small list of edit actions
 *     referencing existing `bulletId`s. Anything off-schema or unknown is
 *     dropped to `rejectedActions`.
 *   - Pinned-safe: respects `metadata.bulletPinned` and `item.pinned` even
 *     if the LLM tries to ignore them.
 *   - Fact-safe: cannot emit `expand_bullet` in shrink mode. Cannot add new
 *     bullets, cannot reorder, cannot change item headers / titles.
 *   - Fallback-first: any failure (no model client, schema invalid, model
 *     error, post-edit regression) returns the input unchanged with a
 *     populated `editReport` describing why.
 */
export type ResumeFitEditorTrigger = "still_overflowing" | "fill_underflow";

export type ResumeFitEditorActionInput =
  | { type: "shorten_bullet"; itemId: string; bulletId: string; newText: string }
  | { type: "rephrase_bullet"; itemId: string; bulletId: string; newText: string }
  | { type: "drop_bullet"; itemId: string; bulletId: string }
  | { type: "expand_bullet"; itemId: string; bulletId: string; newText: string };

export type ResumeFitEditorAppliedAction =
  | { type: "shorten_bullet"; itemId: string; bulletId: string; before: string; after: string }
  | { type: "rephrase_bullet"; itemId: string; bulletId: string; before: string; after: string }
  | { type: "drop_bullet"; itemId: string; bulletId: string; before: string }
  | { type: "expand_bullet"; itemId: string; bulletId: string; before: string; after: string };

export type ResumeFitEditorRejectedAction = {
  action: ResumeFitEditorActionInput;
  reason:
    | "unknown_bullet"
    | "pinned_bullet"
    | "pinned_item"
    | "expand_in_shrink_mode"
    | "shrink_in_fill_mode"
    | "shorten_too_small"
    | "newtext_invalid"
    | "duplicate_target";
};

export type ResumeFitEditorReason =
  | "no_model_client"
  | "no_actions"
  | "schema_invalid"
  | "model_error"
  | "regression"
  | "edits_applied"
  | "all_rejected";

export type ResumeFitEditorReport = {
  applied: boolean;
  fallback: boolean;
  trigger: ResumeFitEditorTrigger | null;
  reason: ResumeFitEditorReason;
  initialEstimatedPages: number;
  finalEstimatedPages: number;
  initialOverflowPx: number;
  finalOverflowPx: number;
  initialUnderflowPx: number;
  finalUnderflowPx: number;
  actions: ResumeFitEditorAppliedAction[];
  rejectedActions?: ResumeFitEditorRejectedAction[];
  notes?: string;
  llmReason?: string;
  measuredAt: string;
};

export type ResumeFitEditorMeasureFn = (
  items: ProductResumeItem[],
  density: string,
) => Promise<ResumeFitReport>;

export type ResumeLLMFitEditorChatFn = (input: {
  systemPrompt: string;
  userPayload: string;
}) => Promise<{ content: string }>;

export type ResumeLLMFitEditorOptions = {
  prompt: string;
  chat?: ResumeLLMFitEditorChatFn;
  /** Optional JD summary for grounding. Service forwards verbatim. */
  jdSummary?: string;
  /** Override underflow trigger threshold; default 240px. */
  underflowTriggerPx?: number;
  /** Override newText max length; default 240. */
  newTextMaxLen?: number;
};

export type ResumeFitEditorInput = {
  items: ProductResumeItem[];
  density: string;
  fitReport: ResumeFitReport;
  compressionReport: ResumeCompressionReport | undefined;
  measure: ResumeFitEditorMeasureFn;
};

export type ResumeFitEditorResult = {
  items: ProductResumeItem[];
  density: string;
  fitReport: ResumeFitReport;
  editReport: ResumeFitEditorReport;
};

const ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("shorten_bullet"), itemId: z.string().min(1), bulletId: z.string().min(1), newText: z.string().min(1).max(2000) }),
  z.object({ type: z.literal("rephrase_bullet"), itemId: z.string().min(1), bulletId: z.string().min(1), newText: z.string().min(1).max(2000) }),
  z.object({ type: z.literal("drop_bullet"), itemId: z.string().min(1), bulletId: z.string().min(1) }),
  z.object({ type: z.literal("expand_bullet"), itemId: z.string().min(1), bulletId: z.string().min(1), newText: z.string().min(1).max(2000) }),
]);

const ResponseSchema = z.object({
  actions: z.array(ActionSchema).max(64),
  reason: z.enum(["shrink_to_fit", "fill_underflow", "no_safe_edit"]),
  notes: z.string().max(2000).optional().default(""),
});

export class ResumeLLMFitEditor {
  private readonly prompt: string;
  private readonly chat: ResumeLLMFitEditorChatFn | undefined;
  private readonly jdSummary: string | undefined;
  private readonly underflowTriggerPx: number;
  private readonly newTextMaxLen: number;

  public constructor(options: ResumeLLMFitEditorOptions) {
    this.prompt = options.prompt;
    this.chat = options.chat;
    this.jdSummary = options.jdSummary;
    this.underflowTriggerPx = options.underflowTriggerPx ?? UNDERFLOW_TRIGGER_PX;
    this.newTextMaxLen = options.newTextMaxLen ?? NEWTEXT_MAX_LEN;
  }

  public shouldTrigger(
    fitReport: ResumeFitReport,
    compressionReport: ResumeCompressionReport | undefined,
  ): ResumeFitEditorTrigger | null {
    if (fitReport.templateId !== "one-page-modern") return null;
    if (fitReport.targetPages !== 1) return null;
    if (compressionReport && compressionReport.applied && compressionReport.stillOverflowing) {
      return "still_overflowing";
    }
    if (fitReport.overflowPx > 0) {
      // Overflow still present without Phase 6 having run - Phase 7 was
      // explicitly designed to run AFTER rule-based compression.
      return null;
    }
    const underflow = fitReport.underflowPx ?? Math.max(0, fitReport.pageUsableHeightPx - fitReport.contentHeightPx);
    if (underflow >= this.underflowTriggerPx) return "fill_underflow";
    return null;
  }

  public async edit(input: ResumeFitEditorInput): Promise<ResumeFitEditorResult> {
    const trigger = this.shouldTrigger(input.fitReport, input.compressionReport);
    const initial = input.fitReport;
    const initialUnderflow = initial.underflowPx ?? Math.max(0, initial.pageUsableHeightPx - initial.contentHeightPx);

    const baseReport = (
      reason: ResumeFitEditorReason,
      extras: Partial<ResumeFitEditorReport> = {},
    ): ResumeFitEditorReport => ({
      applied: false,
      fallback: true,
      trigger,
      reason,
      initialEstimatedPages: initial.estimatedPages,
      finalEstimatedPages: initial.estimatedPages,
      initialOverflowPx: initial.overflowPx,
      finalOverflowPx: initial.overflowPx,
      initialUnderflowPx: initialUnderflow,
      finalUnderflowPx: initialUnderflow,
      actions: [],
      measuredAt: new Date().toISOString(),
      ...extras,
    });

    if (!trigger) {
      return { items: input.items, density: input.density, fitReport: input.fitReport, editReport: baseReport("no_actions") };
    }
    if (!this.chat) {
      return { items: input.items, density: input.density, fitReport: input.fitReport, editReport: baseReport("no_model_client") };
    }

    const userPayload = buildUserPayload({
      trigger,
      items: input.items,
      fitReport: input.fitReport,
      jdSummary: this.jdSummary,
      compressionReport: input.compressionReport,
    });

    let raw: string;
    try {
      const response = await this.chat({ systemPrompt: this.prompt, userPayload });
      raw = response.content ?? "";
    } catch (error) {
      return { items: input.items, density: input.density, fitReport: input.fitReport, editReport: baseReport("model_error", { llmReason: messageOf(error) }) };
    }

    const parsed = safeParseJsonOutput<unknown>(raw, { expected: "object" });
    if (!parsed.ok) {
      return { items: input.items, density: input.density, fitReport: input.fitReport, editReport: baseReport("schema_invalid", { llmReason: parsed.error.message }) };
    }
    const validation = ResponseSchema.safeParse(parsed.value);
    if (!validation.success) {
      return { items: input.items, density: input.density, fitReport: input.fitReport, editReport: baseReport("schema_invalid", { llmReason: validation.error.issues.slice(0, 3).map((i) => i.message).join("; ") }) };
    }

    const llmActions = validation.data.actions.slice(0, MAX_ACTIONS);
    const { applied, rejected, items: nextItems } = applyActions(input.items, llmActions, trigger, this.newTextMaxLen);

    if (applied.length === 0) {
      return {
        items: input.items,
        density: input.density,
        fitReport: input.fitReport,
        editReport: baseReport("all_rejected", {
          rejectedActions: rejected,
          notes: validation.data.notes,
          llmReason: validation.data.reason,
        }),
      };
    }

    let nextReport: ResumeFitReport;
    try {
      nextReport = await input.measure(nextItems, input.density);
    } catch (error) {
      return {
        items: input.items,
        density: input.density,
        fitReport: input.fitReport,
        editReport: baseReport("model_error", { llmReason: `measure failed: ${messageOf(error)}` }),
      };
    }

    const beforeBadness = badness(initial);
    const afterBadness = badness(nextReport);
    if (afterBadness > beforeBadness) {
      // Edits made things worse. Roll back: keep original items + report.
      return {
        items: input.items,
        density: input.density,
        fitReport: input.fitReport,
        editReport: baseReport("regression", {
          rejectedActions: rejected,
          notes: validation.data.notes,
          llmReason: validation.data.reason,
        }),
      };
    }

    const finalUnderflow = nextReport.underflowPx ?? Math.max(0, nextReport.pageUsableHeightPx - nextReport.contentHeightPx);
    return {
      items: nextItems,
      density: input.density,
      fitReport: nextReport,
      editReport: {
        applied: true,
        fallback: false,
        trigger,
        reason: "edits_applied",
        initialEstimatedPages: initial.estimatedPages,
        finalEstimatedPages: nextReport.estimatedPages,
        initialOverflowPx: initial.overflowPx,
        finalOverflowPx: nextReport.overflowPx,
        initialUnderflowPx: initialUnderflow,
        finalUnderflowPx: finalUnderflow,
        actions: applied,
        rejectedActions: rejected.length > 0 ? rejected : undefined,
        notes: validation.data.notes,
        llmReason: validation.data.reason,
        measuredAt: new Date().toISOString(),
      },
    };
  }
}

// ---- helpers ----------------------------------------------------------------

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

function messageOf(error: unknown): string {
  if (!error) return "";
  if (error instanceof Error) return error.message;
  return String(error);
}

function badness(report: ResumeFitReport): number {
  // Combine overflow and underflow into a single "worse" score.
  // Overflow is much worse than underflow per pixel.
  const overflow = Math.max(0, report.overflowPx);
  const underflow = report.underflowPx ?? Math.max(0, report.pageUsableHeightPx - report.contentHeightPx);
  return overflow * 4 + underflow;
}

function readBoolMap(meta: Record<string, unknown> | undefined, key: string): Record<string, boolean> {
  if (!meta) return {};
  const v = meta[key];
  if (!v || typeof v !== "object") return {};
  const out: Record<string, boolean> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "boolean") out[k] = val;
  }
  return out;
}

function readNumberMap(meta: Record<string, unknown> | undefined, key: string): Record<string, number> {
  if (!meta) return {};
  const v = meta[key];
  if (!v || typeof v !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "number" && Number.isFinite(val)) out[k] = val;
  }
  return out;
}

function readStringArray(meta: Record<string, unknown> | undefined, key: string): string[] {
  if (!meta) return [];
  const v = meta[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function cloneItems(items: ProductResumeItem[]): ProductResumeItem[] {
  return items.map((it) => ({
    ...it,
    metadata: cloneMetadata(it.metadata),
  }));
}

function cloneMetadata(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!meta) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (Array.isArray(v)) out[k] = v.slice();
    else if (v && typeof v === "object") out[k] = { ...(v as Record<string, unknown>) };
    else out[k] = v;
  }
  return out;
}


function buildUserPayload(input: {
  trigger: ResumeFitEditorTrigger;
  items: ProductResumeItem[];
  fitReport: ResumeFitReport;
  jdSummary: string | undefined;
  compressionReport: ResumeCompressionReport | undefined;
}): string {
  const items = input.items.filter((i) => !i.hidden).map((it) => {
    const meta = (it.metadata ?? {}) as Record<string, unknown>;
    const bulletIds = readStringArray(meta, "bulletIds");
    const pinnedMap = readBoolMap(meta, "bulletPinned");
    const optionalMap = readBoolMap(meta, "bulletOptional");
    const relevanceMap = readNumberMap(meta, "bulletRelevance");
    const parsed = parseSnapshot(it.contentSnapshot);
    return {
      itemId: typeof meta.itemId === "string" ? meta.itemId : it.id,
      sectionType: it.sectionType,
      title: it.title,
      header: parsed.header,
      pinned: !!it.pinned,
      bullets: parsed.bullets.map((text, i) => {
        const bid = bulletIds[i] ?? `_bullet_${i}`;
        return {
          bulletId: bid,
          text,
          pinned: !!pinnedMap[bid],
          optional: !!optionalMap[bid],
          relevance: typeof relevanceMap[bid] === "number" ? relevanceMap[bid] : 0.5,
          lengthChars: text.length,
        };
      }),
    };
  });

  const compressionActions = input.compressionReport
    ? input.compressionReport.actions.map((a) => `${a.type}`)
    : [];

  const payload = {
    trigger: input.trigger,
    fit: {
      overflowPx: input.fitReport.overflowPx,
      underflowPx: input.fitReport.underflowPx ?? Math.max(0, input.fitReport.pageUsableHeightPx - input.fitReport.contentHeightPx),
      estimatedPages: input.fitReport.estimatedPages,
      density: input.fitReport.density,
    },
    items,
    jdSummary: input.jdSummary ?? null,
    compressionActions,
  };
  return JSON.stringify(payload);
}

type ApplyResult = {
  items: ProductResumeItem[];
  applied: ResumeFitEditorAppliedAction[];
  rejected: ResumeFitEditorRejectedAction[];
};

function applyActions(
  source: ProductResumeItem[],
  actions: ResumeFitEditorActionInput[],
  trigger: ResumeFitEditorTrigger,
  newTextMaxLen: number,
): ApplyResult {
  const items = cloneItems(source);
  const applied: ResumeFitEditorAppliedAction[] = [];
  const rejected: ResumeFitEditorRejectedAction[] = [];
  // Track which (itemId, bulletId) pairs we've already mutated so two
  // actions on the same bullet don't fight each other.
  const claimed = new Set<string>();
  // Limit fill_underflow expand_bullet to 3 for safety.
  let expandsUsed = 0;
  const EXPAND_LIMIT = 3;

  for (const action of actions) {
    const itemIndex = items.findIndex((it) => {
      const meta = (it.metadata ?? {}) as Record<string, unknown>;
      const metaItemId = typeof meta.itemId === "string" ? meta.itemId : it.id;
      return metaItemId === action.itemId;
    });
    if (itemIndex < 0) {
      rejected.push({ action, reason: "unknown_bullet" });
      continue;
    }
    const item = items[itemIndex];
    if (item.pinned) {
      rejected.push({ action, reason: "pinned_item" });
      continue;
    }
    const meta = (item.metadata ?? {}) as Record<string, unknown>;
    const bulletIds = readStringArray(meta, "bulletIds");
    const pinnedMap = readBoolMap(meta, "bulletPinned");
    const parsed = parseSnapshot(item.contentSnapshot);
    const bulletIndex = bulletIds.indexOf(action.bulletId);
    if (bulletIndex < 0 || bulletIndex >= parsed.bullets.length) {
      rejected.push({ action, reason: "unknown_bullet" });
      continue;
    }
    if (pinnedMap[action.bulletId]) {
      rejected.push({ action, reason: "pinned_bullet" });
      continue;
    }
    const claimKey = `${action.itemId}::${action.bulletId}`;
    if (claimed.has(claimKey)) {
      rejected.push({ action, reason: "duplicate_target" });
      continue;
    }

    const before = parsed.bullets[bulletIndex];

    if (action.type === "expand_bullet") {
      if (trigger !== "fill_underflow") {
        rejected.push({ action, reason: "expand_in_shrink_mode" });
        continue;
      }
      if (expandsUsed >= EXPAND_LIMIT) {
        rejected.push({ action, reason: "duplicate_target" });
        continue;
      }
      const after = sanitizeNewText(action.newText, newTextMaxLen);
      if (!after) {
        rejected.push({ action, reason: "newtext_invalid" });
        continue;
      }
      parsed.bullets[bulletIndex] = after;
      item.contentSnapshot = renderSnapshot(parsed);
      claimed.add(claimKey);
      expandsUsed += 1;
      applied.push({ type: "expand_bullet", itemId: action.itemId, bulletId: action.bulletId, before, after });
      continue;
    }

    if (action.type === "drop_bullet") {
      if (trigger === "fill_underflow") {
        rejected.push({ action, reason: "shrink_in_fill_mode" });
        continue;
      }
      parsed.bullets.splice(bulletIndex, 1);
      const nextIds = bulletIds.slice();
      nextIds.splice(bulletIndex, 1);
      meta.bulletIds = nextIds;
      item.metadata = meta;
      item.contentSnapshot = renderSnapshot(parsed);
      claimed.add(claimKey);
      applied.push({ type: "drop_bullet", itemId: action.itemId, bulletId: action.bulletId, before });
      continue;
    }

    // shorten_bullet | rephrase_bullet
    if (trigger === "fill_underflow") {
      rejected.push({ action, reason: "shrink_in_fill_mode" });
      continue;
    }
    const after = sanitizeNewText(action.newText, newTextMaxLen);
    if (!after) {
      rejected.push({ action, reason: "newtext_invalid" });
      continue;
    }
    if (action.type === "shorten_bullet" && before.length - after.length < SHORTEN_MIN_SAVING_CHARS) {
      rejected.push({ action, reason: "shorten_too_small" });
      continue;
    }
    parsed.bullets[bulletIndex] = after;
    item.contentSnapshot = renderSnapshot(parsed);
    claimed.add(claimKey);
    if (action.type === "shorten_bullet") {
      applied.push({ type: "shorten_bullet", itemId: action.itemId, bulletId: action.bulletId, before, after });
    } else {
      applied.push({ type: "rephrase_bullet", itemId: action.itemId, bulletId: action.bulletId, before, after });
    }
  }

  return { items, applied, rejected };
}

function sanitizeNewText(text: string, maxLen: number): string | null {
  let cleaned = (text ?? "").replace(/\r?\n+/g, " ").replace(/\s+/g, " ").trim();
  cleaned = cleaned.replace(/^[-\u2022*]\s+/, "");
  if (cleaned.length === 0) return null;
  if (cleaned.length > maxLen) cleaned = cleaned.slice(0, maxLen).trimEnd();
  return cleaned;
}
