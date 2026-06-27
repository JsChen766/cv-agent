import type { ProductResumeDetail, ProductResumeItem } from "../../product/types.js";
import { A4_ONE_PAGE_SPEC, type ResumePageSpec } from "./PageSpec.js";
import { LayoutSessionManager } from "./LayoutSessionManager.js";
import type { ResumeLayoutReport, ResumeLayoutSession } from "./ResumeLayoutOracle.js";

export type ResumeLayoutComposerResult = {
  resume: ProductResumeDetail;
  report: ResumeLayoutReport;
  actions: ResumeLayoutComposerAction[];
};

export type ResumeLayoutComposerAction =
  | { type: "accept_item"; itemId: string }
  | { type: "reject_item"; itemId: string; reason: string }
  | { type: "accept_bullet"; itemId: string; bulletText: string; variant: "original" | "shortened" }
  | { type: "reject_bullet"; itemId: string; bulletText: string; reason: string };

export type ResumeLayoutComposerInput = {
  layoutSessionId: string;
  resume: ProductResumeDetail;
  templateId: string;
  density: string;
  renderHtml: (resume: ProductResumeDetail) => string;
};

type ParsedSnapshot = {
  header: string;
  bullets: string[];
  trailing: string[];
};

export type ResumeLayoutSessionRunner = {
  withSession<T>(
    input: { layoutSessionId: string; templateId: string; density: string },
    fn: (session: ResumeLayoutSession) => Promise<T>,
  ): Promise<T>;
};

export class ResumeLayoutComposer {
  public constructor(
    private readonly sessions: ResumeLayoutSessionRunner = new LayoutSessionManager(),
    private readonly spec: ResumePageSpec = A4_ONE_PAGE_SPEC,
  ) {}

  public async compose(input: ResumeLayoutComposerInput): Promise<ResumeLayoutComposerResult> {
    return this.sessions.withSession(
      {
        layoutSessionId: input.layoutSessionId,
        templateId: input.templateId,
        density: input.density,
      },
      async (session) => this.composeInSession(input, session),
    );
  }

  private async composeInSession(
    input: ResumeLayoutComposerInput,
    session: ResumeLayoutSession,
  ): Promise<ResumeLayoutComposerResult> {
    const actions: ResumeLayoutComposerAction[] = [];
    const baseReport = await session.measure(input.renderHtml(input.resume));
    if (isPassing(baseReport)) {
      return { resume: input.resume, report: baseReport, actions };
    }

    const acceptedItems: ProductResumeItem[] = [];
    let lastPassingReport: ResumeLayoutReport | undefined;

    for (const item of input.resume.items.filter((entry) => !entry.hidden).sort(compareItems)) {
      const parsed = parseSnapshot(item.contentSnapshot);
      if (parsed.bullets.length === 0) {
        const candidateItems = [...acceptedItems, cloneItem(item)];
        const report = await this.measureItems(input, session, candidateItems);
        if (isPassing(report)) {
          acceptedItems.push(cloneItem(item));
          lastPassingReport = report;
          actions.push({ type: "accept_item", itemId: item.id });
        } else {
          actions.push({ type: "reject_item", itemId: item.id, reason: explainFailure(report) });
        }
        continue;
      }

      const acceptedBullets: string[] = [];
      for (const bullet of parsed.bullets) {
        let accepted = false;
        for (const variant of bulletVariants(bullet)) {
          const candidateItem = cloneItem(item);
          candidateItem.contentSnapshot = renderSnapshot({
            ...parsed,
            bullets: [...acceptedBullets, variant.text],
          });
          const candidateItems = [...acceptedItems, candidateItem];
          const report = await this.measureItems(input, session, candidateItems);
          if (isPassing(report)) {
            acceptedBullets.push(variant.text);
            lastPassingReport = report;
            actions.push({
              type: "accept_bullet",
              itemId: item.id,
              bulletText: variant.text,
              variant: variant.text === bullet ? "original" : "shortened",
            });
            accepted = true;
            break;
          }
        }
        if (!accepted) {
          const failedReport = await this.measureItems(input, session, [
            ...acceptedItems,
            { ...cloneItem(item), contentSnapshot: renderSnapshot({ ...parsed, bullets: [...acceptedBullets, bullet] }) },
          ]);
          actions.push({
            type: "reject_bullet",
            itemId: item.id,
            bulletText: bullet,
            reason: explainFailure(failedReport),
          });
        }
      }

      if (acceptedBullets.length > 0) {
        const finalItem = cloneItem(item);
        finalItem.contentSnapshot = renderSnapshot({ ...parsed, bullets: acceptedBullets });
        acceptedItems.push(finalItem);
      } else {
        actions.push({ type: "reject_item", itemId: item.id, reason: "no bullets satisfied the layout constraints" });
      }
    }

    if (acceptedItems.length === 0) {
      const report = await this.measureItems(input, session, input.resume.items);
      return { resume: input.resume, report, actions };
    }

    const finalResume = withItems(input.resume, acceptedItems);
    const finalReport = lastPassingReport ?? await this.measureItems(input, session, acceptedItems);
    return { resume: finalResume, report: finalReport, actions };
  }

  private async measureItems(
    input: ResumeLayoutComposerInput,
    session: ResumeLayoutSession,
    items: ProductResumeItem[],
  ): Promise<ResumeLayoutReport> {
    const html = input.renderHtml(withItems(input.resume, items));
    return session.measure(html);
  }
}

function isPassing(report: ResumeLayoutReport): boolean {
  return report.fitsPage && report.passesBulletWidthRule;
}

function explainFailure(report: ResumeLayoutReport): string {
  if (!report.fitsPage) return `overflow ${report.overflowPx}px`;
  if (!report.passesBulletWidthRule) {
    const first = report.invalidBullets[0];
    if (!first) return "bullet width rule failed";
    return `bullet ${first.bulletId || "(unknown)"} line widths ${first.lineWidthsPx.join(",")} below ${first.minRequiredLineWidthPx}px or exceeds ${report.maxBulletLines} lines`;
  }
  return "unknown layout failure";
}

function compareItems(a: ProductResumeItem, b: ProductResumeItem): number {
  const sa = numericMetadata(a, "sectionOrder");
  const sb = numericMetadata(b, "sectionOrder");
  if (sa !== sb) return sa - sb;
  return a.orderIndex - b.orderIndex;
}

function numericMetadata(item: ProductResumeItem, key: string): number {
  const value = item.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function cloneItem(item: ProductResumeItem): ProductResumeItem {
  return {
    ...item,
    metadata: cloneMetadata(item.metadata),
  };
}

function cloneMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value ?? {})) {
    if (Array.isArray(raw)) out[key] = raw.slice();
    else if (raw && typeof raw === "object") out[key] = { ...(raw as Record<string, unknown>) };
    else out[key] = raw;
  }
  return out;
}

function withItems(resume: ProductResumeDetail, items: ProductResumeItem[]): ProductResumeDetail {
  const synthetic = { ...resume, items: items.map(cloneItem) };
  (synthetic as unknown as { metadata: Record<string, unknown> }).metadata = {
    ...((resume as unknown as { metadata?: Record<string, unknown> }).metadata ?? {}),
    density: ((resume as unknown as { metadata?: Record<string, unknown> }).metadata ?? {}).density ?? A4_ONE_PAGE_SPEC.defaultDensity,
  };
  return synthetic;
}

function parseSnapshot(snapshot: string): ParsedSnapshot {
  const lines = (snapshot ?? "").split(/\r?\n/);
  let header = "";
  const bullets: string[] = [];
  const trailing: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^[-\u2022*]\s+(.*)$/.exec(line);
    if (match) {
      bullets.push(match[1].trim());
      continue;
    }
    if (!header && bullets.length === 0) {
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
  for (const bullet of parsed.bullets) lines.push(`- ${bullet}`);
  for (const line of parsed.trailing) lines.push(line);
  return lines.join("\n");
}

function bulletVariants(text: string): Array<{ text: string }> {
  const targets = [text.length, 150, 130, 110, 95, 78, 70, 64, 58, 52, 48, 44, 40];
  const variants: string[] = [];
  variants.push(text);
  for (const next of clausePrefixVariants(text)) {
    if (next.length >= 28 && !variants.includes(next)) variants.push(next);
  }
  for (const target of targets) {
    if (target < text.length && containsCjk(text)) continue;
    const next = target >= text.length ? text : truncateAtBoundary(text, target);
    if (next.length >= 28 && !variants.includes(next)) variants.push(next);
  }
  return variants.map((value) => ({ text: value }));
}

function containsCjk(text: string): boolean {
  return /[\u3400-\u9FFF]/u.test(text);
}

function clausePrefixVariants(text: string): string[] {
  const boundaries: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (/[,;，；。、]/u.test(text[index] ?? "")) boundaries.push(index + 1);
  }
  return boundaries
    .map((end) => cleanVariantText(text.slice(0, end)))
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index)
    .sort((a, b) => b.length - a.length);
}

function cleanVariantText(value: string): string {
  return value
    .replace(/[（(][^）)]*$/u, "")
    .replace(/[\s,;:，；、.\-\u2014\u2013]+$/u, "");
}

function truncateAtBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const slice = text.slice(0, maxLen);
  const ws = slice.lastIndexOf(" ");
  const punctuation = Math.max(
    slice.lastIndexOf("，"),
    slice.lastIndexOf("；"),
    slice.lastIndexOf(";"),
    slice.lastIndexOf(","),
    slice.lastIndexOf("。"),
    slice.lastIndexOf("."),
  );
  const cut = punctuation > maxLen * 0.55
    ? slice.slice(0, punctuation + 1)
    : ws > maxLen * 0.6
      ? slice.slice(0, ws)
      : slice;
  return cleanVariantText(cut);
}
