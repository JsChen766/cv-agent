import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResumeHtmlRenderer } from "../src/exports/ResumeHtmlRenderer.js";
import { defaultTemplate } from "../src/exports/templates/defaultTemplate.js";
import { onePageModernTemplate } from "../src/exports/templates/onePageModernTemplate.js";
import type { ProductResumeDetail, ProductResumeItem } from "../src/product/types.js";
import { createServer } from "../src/api/createServer.js";
import { createKernel } from "../src/api/kernel/createKernel.js";
import { FakePdfRenderer, type PdfRendererAdapter } from "../src/exports/index.js";
import type { ApiSuccess } from "../src/api/response.js";
import type { ApiKernel } from "../src/api/types.js";
import type { BackgroundJob } from "../src/platform/index.js";
import type { ResumeExport } from "../src/exports/index.js";

function buildItem(over: Partial<ProductResumeItem> = {}): ProductResumeItem {
  const now = "2025-01-01T00:00:00.000Z";
  return {
    id: over.id ?? "item-1",
    resumeId: over.resumeId ?? "resume-1",
    userId: over.userId ?? "user-1",
    sourceExperienceId: over.sourceExperienceId,
    sourceVariantId: over.sourceVariantId,
    sourceArtifactId: over.sourceArtifactId,
    sectionType: over.sectionType ?? "experience",
    title: over.title ?? "Senior Engineer",
    contentSnapshot: over.contentSnapshot ?? "Senior Engineer",
    orderIndex: over.orderIndex ?? 0,
    hidden: over.hidden ?? false,
    pinned: over.pinned ?? false,
    metadata: over.metadata ?? {},
    createdAt: over.createdAt ?? now,
    updatedAt: over.updatedAt ?? now,
  };
}

function buildResume(items: ProductResumeItem[], over: Partial<ProductResumeDetail> = {}): ProductResumeDetail {
  const now = "2025-01-01T00:00:00.000Z";
  return {
    id: over.id ?? "resume-1",
    userId: over.userId ?? "user-1",
    title: over.title ?? "Jane Doe",
    targetRole: over.targetRole,
    jdId: over.jdId,
    templateId: over.templateId,
    status: over.status ?? "draft",
    createdAt: over.createdAt ?? now,
    updatedAt: over.updatedAt ?? now,
    items,
  };
}

describe("onePageModernTemplate — registration & contract", () => {
  it("registers under id 'one-page-modern' alongside the default template", () => {
    const renderer = new ResumeHtmlRenderer();
    expect(renderer.listTemplateIds().sort()).toEqual(["default", "one-page-modern"]);
  });

  it("falls back to the default template when an unknown templateId is requested", () => {
    const renderer = new ResumeHtmlRenderer();
    const resume = buildResume([buildItem({ contentSnapshot: "Hello world." })]);
    const html = renderer.render(resume, "no-such-template");
    expect(html).not.toContain('data-template="one-page-modern"');
    expect(html).toContain("<h2>Senior Engineer</h2>");
  });
});

describe("onePageModernTemplate — defaultTemplate zero-regression", () => {
  it("renders byte-identical HTML to defaultTemplate() when templateId is omitted", () => {
    const renderer = new ResumeHtmlRenderer();
    const resume = buildResume(
      [
        buildItem({ id: "i1", title: "Senior Engineer", contentSnapshot: "Built things.", orderIndex: 0 }),
        buildItem({ id: "i2", title: "Education", contentSnapshot: "BSc CS", orderIndex: 1, sectionType: "education" }),
      ],
      { title: "Resume A", targetRole: "Engineer" },
    );
    const viaRenderer = renderer.render(resume);
    const viaTemplate = defaultTemplate().render({ resume });
    expect(viaRenderer).toBe(viaTemplate);
  });
});

describe("onePageModernTemplate — visual contract", () => {
  it("emits A4 print rules, the one-page-modern marker, and the default density", () => {
    const html = onePageModernTemplate().render({
      resume: buildResume([buildItem({ contentSnapshot: "Built things." })]),
    });
    expect(html).toContain("@page");
    expect(html).toContain("size: A4");
    expect(html).toContain('data-template="one-page-modern"');
    expect(html).toContain('data-density="standard"');
    expect(html).toContain('class="resume density-standard"');
    expect(html).toContain("page-break-inside: avoid");
  });

  it("preserves Chinese characters in titles, headers, and bullets without mangling", () => {
    const item = buildItem({
      title: "高级前端工程师",
      contentSnapshot: "高级前端工程师 \u00B7 字节跳动 \u00B7 2022.03 \u2013 2024.06\n- 主导设计系统重构\n- 推动 SSR 上线",
      sectionType: "experience",
    });
    const html = onePageModernTemplate().render({
      resume: buildResume([item], { title: "前端工程师简历", targetRole: "高级前端工程师" }),
    });
    expect(html).toContain("前端工程师简历");
    expect(html).toContain("高级前端工程师");
    expect(html).toContain("字节跳动");
    expect(html).toContain("2022.03 \u2013 2024.06");
    expect(html).toContain("主导设计系统重构");
    expect(html).toContain("推动 SSR 上线");
    expect(html).toMatch(/<li>主导设计系统重构<\/li>/);
    expect(html).toMatch(/<span class="item-period">2022\.03/);
  });
});

describe("onePageModernTemplate — structured (Phase 3) data path", () => {
  it("groups items by section, sorts by metadata.sectionOrder, and emits data-item-id / data-bullet-id", () => {
    const itemEdu = buildItem({
      id: "i-edu",
      sectionType: "education",
      title: "BSc Computer Science",
      contentSnapshot: "BSc Computer Science \u00B7 Tsinghua University \u00B7 2014 \u2013 2018",
      orderIndex: 9,
      metadata: { sectionId: "sec-edu", sectionType: "education", sectionOrder: 3, itemId: "doc-edu-1", bulletIds: [] },
    });
    const itemExpA = buildItem({
      id: "i-exp-a",
      sectionType: "experience",
      title: "Senior Engineer",
      contentSnapshot: "Senior Engineer \u00B7 Acme \u00B7 2022 \u2013 2024\n- Led platform rebuild\n- Cut p95 latency by 40%",
      orderIndex: 1,
      metadata: { sectionId: "sec-exp", sectionType: "experience", sectionOrder: 1, itemId: "doc-exp-a", bulletIds: ["b-a-1", "b-a-2"] },
    });
    const itemExpB = buildItem({
      id: "i-exp-b",
      sectionType: "experience",
      title: "Engineer",
      contentSnapshot: "Engineer \u00B7 Beta Corp \u00B7 2020 \u2013 2022\n- Shipped core API",
      orderIndex: 0,
      metadata: { sectionId: "sec-exp", sectionType: "experience", sectionOrder: 2, itemId: "doc-exp-b", bulletIds: ["b-b-1"] },
    });
    const html = onePageModernTemplate().render({
      resume: buildResume([itemEdu, itemExpB, itemExpA], { title: "Jane Doe", targetRole: "Engineer" }),
    });

    const expIdx = html.indexOf('data-section-type="experience"');
    const eduIdx = html.indexOf('data-section-type="education"');
    expect(expIdx).toBeGreaterThan(0);
    expect(eduIdx).toBeGreaterThan(expIdx);

    const aIdx = html.indexOf('data-item-id="doc-exp-a"');
    const bIdx = html.indexOf('data-item-id="doc-exp-b"');
    expect(aIdx).toBeGreaterThan(0);
    expect(bIdx).toBeGreaterThan(aIdx);

    expect(html).toContain('data-bullet-id="b-a-1"');
    expect(html).toContain('data-bullet-id="b-a-2"');
    expect(html).toContain('data-bullet-id="b-b-1"');

    expect(html).toContain("Led platform rebuild");
    expect(html).toContain("Cut p95 latency by 40%");
    expect(html).toContain('<span class="item-period">2022 \u2013 2024</span>');
  });
});

describe("onePageModernTemplate — legacy data path", () => {
  it("renders pre-Phase-3 items (no metadata, single-paragraph contentSnapshot) as item-body paragraphs", () => {
    const legacy = buildItem({
      id: "legacy-1",
      title: "Highlights",
      contentSnapshot: "Built reliable systems across three different startups.",
      sectionType: "experience",
      metadata: {},
    });
    const html = onePageModernTemplate().render({
      resume: buildResume([legacy], { title: "Legacy Resume" }),
    });
    expect(html).toContain('class="item-body"');
    expect(html).toContain("Built reliable systems across three different startups.");
    expect(html).not.toContain('<ul class="bullets">');
    expect(html).not.toContain("data-item-id=");
  });

  it("hides items with hidden=true regardless of data path", () => {
    const visible = buildItem({ id: "v", contentSnapshot: "Visible item.", title: "Visible" });
    const hidden = buildItem({ id: "h", contentSnapshot: "Hidden item.", title: "Hidden", hidden: true });
    const html = onePageModernTemplate().render({
      resume: buildResume([visible, hidden]),
    });
    expect(html).toContain("Visible item.");
    expect(html).not.toContain("Hidden item.");
  });

  it("renders skill section as inline chips, splitting on Chinese and ASCII separators", () => {
    const skillItem = buildItem({
      id: "skill-1",
      sectionType: "skill",
      title: "Skills",
      contentSnapshot: "TypeScript, React, Node.js\u3001Vue\uFF1BPostgres",
    });
    const html = onePageModernTemplate().render({
      resume: buildResume([skillItem]),
    });
    expect(html).toContain('data-section-type="skill"');
    expect(html).toContain('class="skill-chip">TypeScript<');
    expect(html).toContain('class="skill-chip">React<');
    expect(html).toContain('class="skill-chip">Node.js<');
    expect(html).toContain('class="skill-chip">Vue<');
    expect(html).toContain('class="skill-chip">Postgres<');
  });
});

describe("onePageModernTemplate — PDF export e2e (FakePdfRenderer)", () => {
  let kernel: ApiKernel;
  let server: Awaited<ReturnType<typeof createServer>>;
  let renderer: PdfRendererAdapter;
  let capturedHtml = "";

  beforeEach(async () => {
    process.env.AUTH_MODE = "dev_header";
    process.env.AGENT_PROVIDER = "mock";
    process.env.NODE_ENV = "test";
    process.env.JOB_WORKER_ENABLED = "false";
    process.env.PDF_RENDERER = "playwright";
    process.env.FILE_STORAGE_PROVIDER = "memory";
    delete process.env.DATABASE_URL;

    capturedHtml = "";
    renderer = {
      async render(html: string) {
        capturedHtml = html;
        return new FakePdfRenderer().render(html);
      },
    };
    kernel = await createKernel({ pdfRenderer: renderer });
    server = await createServer(kernel);
  });

  afterEach(async () => {
    delete process.env.JOB_WORKER_ENABLED;
    delete process.env.PDF_RENDERER;
    delete process.env.FILE_STORAGE_PROVIDER;
    if (server) await server.close();
    if (kernel) await kernel.close();
  });

  it("creates a pdf export with templateId=one-page-modern and feeds the rendered HTML through the adapter", async () => {
    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "Modern PDF" });
    await kernel.productServices.resumeService.addResumeItem("user-1", resume.id, {
      title: "Senior Engineer",
      contentSnapshot: "Senior Engineer \u00B7 Acme \u00B7 2022 \u2013 2024\n- Led platform rebuild\n- Cut p95 latency",
    });

    const created = await server.inject({
      method: "POST",
      url: `/exports/resumes/${resume.id}`,
      headers: { "x-user-id": "user-1", "content-type": "application/json" },
      payload: { format: "pdf", templateId: "one-page-modern" },
    });
    expect(created.statusCode).toBe(200);
    const data = (created.json() as ApiSuccess<{ exportRecord: ResumeExport; job: BackgroundJob }>).data;
    expect(data.exportRecord.templateId).toBe("one-page-modern");

    await kernel.jobRunner.runJob(data.job.id, "user-1");

    const completed = await kernel.exportService.getExport("user-1", data.exportRecord.id);
    expect(completed?.status).toBe("completed");
    expect(completed?.templateId).toBe("one-page-modern");
    expect(completed?.fileId).toEqual(expect.any(String));

    // The HTML the adapter received MUST come from onePageModernTemplate, not default.
    expect(capturedHtml).toContain('data-template="one-page-modern"');
    expect(capturedHtml).toContain("@page");
    expect(capturedHtml).toContain("Led platform rebuild");

    const download = await server.inject({
      method: "GET",
      url: `/exports/${data.exportRecord.id}/download`,
      headers: { "x-user-id": "user-1" },
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toBe("application/pdf");
    const body = download.rawPayload ?? Buffer.from(download.body);
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.subarray(0, 5).toString("utf8")).toBe("%PDF-");
  });
});
