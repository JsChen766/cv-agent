import type { ProductResumeDetail } from "../../product/types.js";

export type ResumeTemplateContext = {
  resume: ProductResumeDetail;
};

export type ResumeTemplate = {
  id: string;
  name: string;
  render(context: ResumeTemplateContext): string;
};

export function defaultTemplate(): ResumeTemplate {
  return {
    id: "default",
    name: "Default",
    render,
  };
}

function render({ resume }: ResumeTemplateContext): string {
  const items = resume.items
    .filter((item) => !item.hidden)
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((item) => `<section><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.contentSnapshot)}</p></section>`)
    .join("\n");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(resume.title)}</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 760px; margin: 40px auto; color: #1f2937; line-height: 1.5; }
    h1 { font-size: 28px; margin-bottom: 4px; }
    .role { color: #4b5563; margin-bottom: 24px; }
    section { border-top: 1px solid #e5e7eb; padding: 16px 0; }
    h2 { font-size: 16px; margin: 0 0 8px; }
    p { white-space: pre-wrap; margin: 0; }
  </style>
</head>
<body>
  <h1>${escapeHtml(resume.title)}</h1>
  ${resume.targetRole ? `<div class="role">${escapeHtml(resume.targetRole)}</div>` : ""}
  ${items}
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
