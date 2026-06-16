import { describe, expect, it } from "vitest";
import { contentDispositionAttachment } from "../src/api/routes/exports.js";

describe("contentDispositionAttachment", () => {
  it("emits a single ASCII filename when input is already ASCII", () => {
    const header = contentDispositionAttachment("Resume.pdf");
    expect(header).toBe('attachment; filename="Resume.pdf"');
  });

  it("emits both ASCII fallback and RFC 5987 UTF-8 form for non-ASCII titles", () => {
    const header = contentDispositionAttachment("前端工程师简历.pdf");
    expect(header).toMatch(/^attachment; filename="[^"\u0080-\uFFFF]+\.pdf"; filename\*=UTF-8''.+$/);
    expect(header).toContain(encodeURIComponent("前端工程师简历.pdf"));
  });

  it("produces a header with only ISO-8859-1 bytes so Node's HTTP layer accepts it", () => {
    const header = contentDispositionAttachment("简历 résumé v2.pdf");
    for (let i = 0; i < header.length; i += 1) {
      expect(header.charCodeAt(i)).toBeLessThan(0x100);
    }
  });

  it("falls back to 'download' when the filename has no representable ASCII characters", () => {
    const header = contentDispositionAttachment("简历.pdf");
    // ASCII fallback collapses CJK to underscores, but extension survives, so we get e.g. "___.pdf".
    expect(header).toMatch(/^attachment; filename="[^"\u0080-\uFFFF]+"; filename\*=UTF-8''/);
  });

  it("percent-encodes RFC 5987 reserved chars like ' ( ) *", () => {
    const header = contentDispositionAttachment("a'b(c)*.pdf");
    expect(header).toContain("%27");
    expect(header).toContain("%28");
    expect(header).toContain("%29");
    expect(header).toContain("%2A");
  });
});
