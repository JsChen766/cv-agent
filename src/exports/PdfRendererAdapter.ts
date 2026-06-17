import { ApiError, ErrorCodes } from "../api/errors.js";

/**
 * Renders a self-contained HTML document to a PDF buffer.
 *
 * Implementations MUST not throw raw underlying errors — they should wrap
 * unexpected failures in {@link PdfRenderError} so the export pipeline can
 * surface a clear, user-actionable message.
 */
export interface PdfRendererAdapter {
  render(html: string): Promise<Buffer>;
}

export class PdfRenderError extends Error {
  public constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "PdfRenderError";
  }
}

export function buildChromiumLaunchOptions(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const options: Record<string, unknown> = {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  };
  if (env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    options.executablePath = env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }
  return options;
}

/**
 * Production renderer that uses Playwright Chromium. Lazy-imports `playwright`
 * so the test/process-startup path does not require chromium binaries to be
 * installed.
 */
export class PlaywrightPdfRenderer implements PdfRendererAdapter {
  public async render(html: string): Promise<Buffer> {
    let chromium;
    try {
      ({ chromium } = await import("playwright"));
    } catch (error) {
      throw new PdfRenderError(
        'Playwright is not installed. Run: npm install playwright (or "npm install" if it is in package.json).',
        error,
      );
    }
    let browser;
    try {
      browser = await chromium.launch(buildChromiumLaunchOptions());
    } catch (error) {
      throw new PdfRenderError(
        "Playwright Chromium is not installed or cannot start. Run: npx playwright install chromium",
        error,
      );
    }
    let page;
    try {
      page = await browser.newPage();
      await page.setContent(html, { waitUntil: "networkidle" });
      const pdfBuffer = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "20mm", right: "15mm", bottom: "20mm", left: "15mm" },
      });
      return Buffer.from(pdfBuffer);
    } catch (error) {
      throw new PdfRenderError(
        `Playwright failed to render PDF: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    } finally {
      try {
        if (page) await page.close();
      } catch {
        // ignore close errors
      }
      try {
        await browser.close();
      } catch {
        // ignore close errors
      }
    }
  }
}

/**
 * Test/dev renderer that produces a deterministic, valid-enough PDF buffer
 * without spawning chromium. The output is a minimal valid PDF that contains
 * the rendered HTML's plain-text payload as a comment so tests can assert on it.
 */
export class FakePdfRenderer implements PdfRendererAdapter {
  public async render(html: string): Promise<Buffer> {
    const text = stripTags(html).slice(0, 4096);
    // Minimal PDF skeleton — recognizable by `application/pdf` consumers and
    // small enough to assert on in tests.
    const body = [
      "%PDF-1.4",
      "% Fake renderer for tests",
      `% ${text.replace(/[\r\n]+/g, " ")}`,
      "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
      "2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj",
      "trailer<</Root 1 0 R>>",
      "%%EOF",
      "",
    ].join("\n");
    return Buffer.from(body, "utf8");
  }
}

export function pdfRenderErrorToApiError(error: unknown): ApiError {
  if (error instanceof PdfRenderError) {
    return new ApiError(ErrorCodes.INTERNAL_ERROR, error.message, 500);
  }
  if (error instanceof ApiError) return error;
  const message = error instanceof Error ? error.message : "PDF render failed.";
  return new ApiError(ErrorCodes.INTERNAL_ERROR, message, 500);
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
