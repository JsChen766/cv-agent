import { buildChromiumLaunchOptions } from "../PdfRendererAdapter.js";
import { A4_ONE_PAGE_SPEC, type ResumePageSpec } from "./PageSpec.js";

export type BulletLineLayout = {
  bulletId: string;
  lineCount: number;
  lineWidthsPx: number[];
  minRequiredLineWidthPx: number;
  passesWidthRule: boolean;
  text: string;
};

export type BlockLayout = {
  id: string;
  heightPx: number;
};

export type ResumeLayoutReport = {
  layoutSessionId: string;
  templateId: string;
  density: string;
  targetPages: number;
  contentWidthPx: number;
  usableHeightPx: number;
  contentHeightPx: number;
  remainingHeightPx: number;
  overflowPx: number;
  fitsPage: boolean;
  bulletMinLineWidthRatio: number;
  maxBulletLines: number;
  passesBulletWidthRule: boolean;
  bulletLayouts: BulletLineLayout[];
  invalidBullets: BulletLineLayout[];
  sectionLayouts: BlockLayout[];
  itemLayouts: BlockLayout[];
  measuredAt: string;
  measurer: "playwright" | "heuristic";
};

export interface ResumeLayoutSession {
  measure(html: string): Promise<ResumeLayoutReport>;
  close(): Promise<void>;
}

export class ResumeLayoutMeasureError extends Error {
  public constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "ResumeLayoutMeasureError";
  }
}

export class ResumeLayoutOracle {
  public constructor(private readonly spec: ResumePageSpec = A4_ONE_PAGE_SPEC) {}

  public async createSession(input: {
    layoutSessionId: string;
    templateId: string;
    density: string;
  }): Promise<ResumeLayoutSession> {
    let chromium;
    try {
      ({ chromium } = await import("playwright"));
    } catch (error) {
      throw new ResumeLayoutMeasureError(
        'Playwright is not installed. Run: npm install playwright (or "npm install" if it is in package.json).',
        error,
      );
    }

    let browser;
    try {
      browser = await chromium.launch(buildChromiumLaunchOptions());
    } catch (error) {
      throw new ResumeLayoutMeasureError(
        "Playwright Chromium is not installed or cannot start. Run: npx playwright install chromium",
        error,
      );
    }

    const context = await browser.newContext({
      viewport: { width: this.spec.pageWidthPx, height: this.spec.pageHeightPx },
    });
    const page = await context.newPage();
    const spec = this.spec;

    return {
      measure: async (html: string): Promise<ResumeLayoutReport> => {
        try {
          await page.setContent(html, { waitUntil: "networkidle" });
          await page.addStyleTag({ content: measurementCss(spec) });
          await page.evaluate("document.fonts ? document.fonts.ready.then(() => true) : true");
          await page.evaluate("globalThis.__name = (value) => value");
          return await page.evaluate(
            ({ layoutSessionId, templateId, density, spec }) => {
              const doc = (globalThis as unknown as { document: any }).document;
              const root = doc.querySelector(".resume");
              const contentWidthPx = spec.contentWidthPx;
              const usableHeightPx = spec.usableHeightPx * spec.targetPages;
              const rootHeight = root
                ? Math.max(root.getBoundingClientRect().height, root.scrollHeight)
                : Math.max(doc.body.getBoundingClientRect().height, doc.body.scrollHeight);
              const bulletMin = Math.round(contentWidthPx * spec.bulletMinLineWidthRatio);

              function mergeRects(rects: Array<{ top: number; width: number; height: number }>): number[] {
                const rows: Array<{ top: number; width: number }> = [];
                for (const rect of rects) {
                  if (rect.width <= 1 || rect.height <= 1) continue;
                  const found = rows.find((row) => Math.abs(row.top - rect.top) < 2);
                  if (found) found.width += rect.width;
                  else rows.push({ top: rect.top, width: rect.width });
                }
                return rows.map((row) => Math.round(row.width));
              }

              function blockLayouts(selector: string, attr: string): Array<{ id: string; heightPx: number }> {
                return Array.from(doc.querySelectorAll(selector)).map((node, index) => {
                  const el = node as any;
                  return {
                    id: el.getAttribute(attr) || `${selector}-${index + 1}`,
                    heightPx: Math.round(el.getBoundingClientRect().height),
                  };
                });
              }

              const bulletLayouts = Array.from(doc.querySelectorAll("li[data-bullet-id]")).map((node) => {
                const li = node as any;
                const range = doc.createRange();
                range.selectNodeContents(li);
                const widths = mergeRects(Array.from(range.getClientRects()) as Array<{ top: number; width: number; height: number }>);
                range.detach();
                const passesLineCount = widths.length > 0 && widths.length <= spec.maxBulletLines;
                const passesWidth = widths.every((width) => width >= bulletMin);
                return {
                  bulletId: li.getAttribute("data-bullet-id") || "",
                  lineCount: widths.length,
                  lineWidthsPx: widths,
                  minRequiredLineWidthPx: bulletMin,
                  passesWidthRule: passesLineCount && passesWidth,
                  text: (li.textContent || "").trim(),
                };
              });
              const invalidBullets = bulletLayouts.filter((item) => !item.passesWidthRule);
              const overflowPx = Math.max(0, Math.round(rootHeight - usableHeightPx));
              return {
                layoutSessionId,
                templateId,
                density,
                targetPages: spec.targetPages,
                contentWidthPx,
                usableHeightPx,
                contentHeightPx: Math.round(rootHeight),
                remainingHeightPx: Math.max(0, Math.round(usableHeightPx - rootHeight)),
                overflowPx,
                fitsPage: overflowPx === 0,
                bulletMinLineWidthRatio: spec.bulletMinLineWidthRatio,
                maxBulletLines: spec.maxBulletLines,
                passesBulletWidthRule: invalidBullets.length === 0,
                bulletLayouts,
                invalidBullets,
                sectionLayouts: blockLayouts("section[data-section-id]", "data-section-id"),
                itemLayouts: blockLayouts("article[data-item-id]", "data-item-id"),
                measuredAt: new Date().toISOString(),
                measurer: "playwright" as const,
              };
            },
            { layoutSessionId: input.layoutSessionId, templateId: input.templateId, density: input.density, spec },
          );
        } catch (error) {
          throw new ResumeLayoutMeasureError(
            `Playwright failed to measure resume layout: ${error instanceof Error ? error.message : String(error)}`,
            error,
          );
        }
      },
      close: async () => {
        try { await page.close(); } catch { /* ignore */ }
        try { await context.close(); } catch { /* ignore */ }
        try { await browser.close(); } catch { /* ignore */ }
      },
    };
  }
}

function measurementCss(spec: ResumePageSpec): string {
  return `
html, body {
  width: ${spec.contentWidthPx}px !important;
  min-width: ${spec.contentWidthPx}px !important;
  max-width: ${spec.contentWidthPx}px !important;
  margin: 0 !important;
  padding: 0 !important;
  background: #fff !important;
}
.resume {
  width: ${spec.contentWidthPx}px !important;
  min-width: ${spec.contentWidthPx}px !important;
  max-width: ${spec.contentWidthPx}px !important;
  margin: 0 !important;
  padding: 0 !important;
}
`;
}
