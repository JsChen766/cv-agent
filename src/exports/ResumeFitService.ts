/**
 * Phase 5 Fit Engine v1: measure whether a rendered resume HTML overflows
 * one A4 page, and record the result as a structured `ResumeFitReport`.
 *
 * Phase 5 deliberately does NOT auto-compress, hide content, or fail an
 * export when the document overflows. It only observes and reports — the
 * compression / mutation logic is reserved for Phase 6.
 *
 * Architecture:
 *   - `ResumeLayoutMeasurer` is the abstraction the pipeline talks to.
 *   - `PlaywrightLayoutMeasurer` lazy-imports Chromium for production.
 *   - `HeuristicLayoutMeasurer` is the deterministic fallback used in
 *     tests and when LAYOUT_MEASURER is unavailable. It walks the HTML
 *     structurally and adds up per-element pixel costs derived from
 *     `onePageModernTemplate`'s actual CSS.
 *   - `ResumeFitService` orchestrates: it owns a measurer and emits a
 *     `ResumeFitReport` ready to persist on the export record.
 */

/**
 * A4 page geometry at 96 CSS pixels per inch (Chromium's default).
 * The default usable area mirrors `onePageModernTemplate`'s 18mm @page
 * margin: a content box of roughly 174 x 261 mm.
 */
export const A4_PAGE_HEIGHT_PX = 1123;
export const A4_PAGE_WIDTH_PX = 794;
const DEFAULT_PAGE_MARGIN_PX = 68;
export const A4_USABLE_HEIGHT_PX = A4_PAGE_HEIGHT_PX - DEFAULT_PAGE_MARGIN_PX * 2;
export const A4_USABLE_WIDTH_PX = A4_PAGE_WIDTH_PX - DEFAULT_PAGE_MARGIN_PX * 2;

export type ResumeFitReport = {
  targetPages: number;
  estimatedPages: number;
  overflowPx: number;
  underflowPx?: number;
  contentHeightPx: number;
  pageUsableHeightPx: number;
  templateId: string;
  density: string;
  measurer: "playwright" | "heuristic";
  measuredAt: string;
};

export type ResumeLayoutMeasureInput = {
  html: string;
  templateId: string;
  density: string;
  pageUsableHeightPx?: number;
};

export type ResumeLayoutMeasurement = {
  contentHeightPx: number;
  pageUsableHeightPx: number;
  measurer: "playwright" | "heuristic";
};

export interface ResumeLayoutMeasurer {
  measure(input: ResumeLayoutMeasureInput): Promise<ResumeLayoutMeasurement>;
}

export class ResumeFitMeasureError extends Error {
  public constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "ResumeFitMeasureError";
  }
}

/**
 * Production measurer. Uses Playwright Chromium to compute true layout
 * height. Lazy-imports `playwright` so the dev/test path that does not
 * have Chromium installed never reaches it.
 */
export class PlaywrightLayoutMeasurer implements ResumeLayoutMeasurer {
  public async measure(input: ResumeLayoutMeasureInput): Promise<ResumeLayoutMeasurement> {
    let chromium;
    try {
      ({ chromium } = await import("playwright"));
    } catch (error) {
      throw new ResumeFitMeasureError(
        'Playwright is not installed. Run: npm install playwright (or "npm install" if it is in package.json).',
        error,
      );
    }
    let browser;
    try {
      browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    } catch (error) {
      throw new ResumeFitMeasureError(
        "Playwright Chromium is not installed or cannot start. Run: npx playwright install chromium",
        error,
      );
    }
    let page;
    try {
      page = await browser.newPage({ viewport: { width: A4_PAGE_WIDTH_PX, height: A4_PAGE_HEIGHT_PX } });
      await page.setContent(input.html, { waitUntil: "networkidle" });
      const contentHeightPx = await page.evaluate(() => {
        // Runs inside Chromium where `document` exists; cast through unknown
        // to avoid pulling the DOM lib into the Node tsconfig.
        const doc = (globalThis as unknown as { document: { querySelector(selector: string): { getBoundingClientRect(): { height: number }; scrollHeight: number } | null; body: { getBoundingClientRect(): { height: number }; scrollHeight: number } } }).document;
        const root = doc.querySelector(".resume") ?? doc.body;
        if (!root) return 0;
        const rectHeight = root.getBoundingClientRect().height;
        const scroll = root.scrollHeight;
        return Math.max(rectHeight, scroll);
      });
      return {
        contentHeightPx: Math.round(contentHeightPx),
        pageUsableHeightPx: input.pageUsableHeightPx ?? A4_USABLE_HEIGHT_PX,
        measurer: "playwright",
      };
    } catch (error) {
      throw new ResumeFitMeasureError(
        `Playwright failed to measure resume layout: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    } finally {
      try { if (page) await page.close(); } catch { /* ignore */ }
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
}

/**
 * Deterministic fallback measurer. Walks the rendered HTML structurally
 * (sections, items, bullets, paragraphs, skill chips) and adds up an
 * estimated CSS-pixel cost per element scaled by the active density.
 *
 * The estimates were derived from `onePageModernTemplate`'s actual CSS
 * (margin, padding, font-size, line-height) — they are intentionally
 * coarse but should never *under*-estimate a long resume's height, which
 * would let an overflow slip past the Phase 6 compressor.
 */
export class HeuristicLayoutMeasurer implements ResumeLayoutMeasurer {
  public async measure(input: ResumeLayoutMeasureInput): Promise<ResumeLayoutMeasurement> {
    return {
      contentHeightPx: computeHeuristicHeight(input.html, input.density),
      pageUsableHeightPx: input.pageUsableHeightPx ?? A4_USABLE_HEIGHT_PX,
      measurer: "heuristic",
    };
  }
}

type DensityCosts = {
  bulletPx: number;
  bodyLinePx: number;
  summaryLinePx: number;
  itemHeaderPx: number;
  itemGapPx: number;
  sectionGapPx: number;
  sectionTitlePx: number;
  mastheadPx: number;
  skillRowPx: number;
};

const DENSITY_TABLE: Record<string, DensityCosts> = {
  comfortable: { bulletPx: 22, bodyLinePx: 22, summaryLinePx: 22, itemHeaderPx: 38, itemGapPx: 12, sectionGapPx: 16, sectionTitlePx: 24, mastheadPx: 78, skillRowPx: 28 },
  standard:    { bulletPx: 19, bodyLinePx: 19, summaryLinePx: 19, itemHeaderPx: 36, itemGapPx: 10, sectionGapPx: 14, sectionTitlePx: 22, mastheadPx: 70, skillRowPx: 26 },
  compact:     { bulletPx: 15, bodyLinePx: 15, summaryLinePx: 15, itemHeaderPx: 30, itemGapPx: 7,  sectionGapPx: 10, sectionTitlePx: 20, mastheadPx: 60, skillRowPx: 22 },
};

function densityCosts(density: string): DensityCosts {
  return DENSITY_TABLE[density] ?? DENSITY_TABLE.standard;
}

/** Average characters per line at A4 content width / 10.5pt (~ 80 chars). */
const CHARS_PER_LINE = 80;

export function computeHeuristicHeight(html: string, density: string): number {
  const c = densityCosts(density);
  let total = 0;

  if (/class="masthead"/.test(html)) total += c.mastheadPx;

  // Each <section>...</section> is one logical block on the page.
  const sectionMatches = matchAll(html, /<section\b[^>]*data-section-type="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g);
  for (const sm of sectionMatches) {
    total += c.sectionGapPx + c.sectionTitlePx;
    const sectionType = sm[1];
    const body = sm[2];
    if (sectionType === "skill") {
      const chips = countOccurrences(body, /<span class="skill-chip">/g);
      // Roughly 6 chips per row at A4 width; one row ~= skillRowPx.
      const rows = Math.max(1, Math.ceil(chips / 6));
      total += rows * c.skillRowPx;
      continue;
    }
    if (sectionType === "summary") {
      const paragraphs = matchAll(body, /<p class="summary-paragraph">([\s\S]*?)<\/p>/g);
      for (const pm of paragraphs) {
        total += linesFor(pm[1], CHARS_PER_LINE) * c.summaryLinePx;
      }
      continue;
    }
    // experience / project / education / award / other
    const items = matchAll(body, /<article class="item"[^>]*>([\s\S]*?)<\/article>/g);
    for (let i = 0; i < items.length; i += 1) {
      const itemBody = items[i][1];
      total += c.itemHeaderPx;
      if (i > 0) total += c.itemGapPx;
      // bullets
      const bullets = matchAll(itemBody, /<li[^>]*>([\s\S]*?)<\/li>/g);
      for (const bm of bullets) {
        total += linesFor(stripTags(bm[1]), CHARS_PER_LINE) * c.bulletPx;
      }
      // paragraph fallback (legacy single-paragraph items)
      const bodies = matchAll(itemBody, /<p class="item-body">([\s\S]*?)<\/p>/g);
      for (const pm of bodies) {
        total += linesFor(stripTags(pm[1]), CHARS_PER_LINE) * c.bodyLinePx;
      }
      // sub-meta line under the item header (subtitle/location)
      if (/<div class="item-meta">/.test(itemBody)) {
        total += c.bodyLinePx;
      }
    }
  }

  return Math.round(total);
}

function matchAll(input: string, regex: RegExp): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  const re = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    out.push(m);
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  return out;
}

function countOccurrences(input: string, regex: RegExp): number {
  return matchAll(input, regex).length;
}

function stripTags(input: string): string {
  return input.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function linesFor(text: string, charsPerLine: number): number {
  const len = text.length;
  if (len === 0) return 0;
  return Math.max(1, Math.ceil(len / Math.max(1, charsPerLine)));
}


/**
 * Tiny orchestrator the export pipeline talks to. It owns the measurer
 * and turns its raw measurement into a `ResumeFitReport`.
 */
export class ResumeFitService {
  public constructor(private readonly measurer: ResumeLayoutMeasurer) {}

  public async measure(input: ResumeLayoutMeasureInput): Promise<ResumeFitReport> {
    const measurement = await this.measurer.measure(input);
    return buildFitReport({
      contentHeightPx: measurement.contentHeightPx,
      pageUsableHeightPx: measurement.pageUsableHeightPx,
      templateId: input.templateId,
      density: input.density,
      measurer: measurement.measurer,
    });
  }
}

export function buildFitReport(input: {
  contentHeightPx: number;
  pageUsableHeightPx: number;
  templateId: string;
  density: string;
  measurer: "playwright" | "heuristic";
  targetPages?: number;
}): ResumeFitReport {
  const targetPages = Math.max(1, input.targetPages ?? 1);
  const usable = Math.max(1, Math.round(input.pageUsableHeightPx));
  const content = Math.max(0, Math.round(input.contentHeightPx));
  const estimatedPages = Math.max(1, Math.ceil(content / usable));
  const overflowPx = Math.max(0, content - usable * targetPages);
  const underflowPx = overflowPx === 0 ? Math.max(0, usable * targetPages - content) : undefined;
  const report: ResumeFitReport = {
    targetPages,
    estimatedPages,
    overflowPx,
    contentHeightPx: content,
    pageUsableHeightPx: usable,
    templateId: input.templateId,
    density: input.density,
    measurer: input.measurer,
    measuredAt: new Date().toISOString(),
  };
  if (underflowPx !== undefined) report.underflowPx = underflowPx;
  return report;
}
