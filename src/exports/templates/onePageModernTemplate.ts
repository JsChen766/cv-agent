import type { ProductResumeItem } from "../../product/types.js";
import type { ResumeTemplate, ResumeTemplateContext } from "./defaultTemplate.js";

export type OnePageModernDensity = "comfortable" | "standard" | "compact";

export function onePageModernTemplate(): ResumeTemplate {
  return {
    id: "one-page-modern",
    name: "One Page Modern",
    render,
  };
}

const DEFAULT_DENSITY: OnePageModernDensity = "standard";
const MIDDOT = "\u00B7";

const SECTION_ORDER: ProductResumeItem["sectionType"][] = [
  "summary",
  "experience",
  "project",
  "education",
  "skill",
  "award",
  "other",
];

const SECTION_LABELS: Record<ProductResumeItem["sectionType"], string> = {
  summary: "Summary",
  experience: "Experience",
  project: "Projects",
  education: "Education",
  skill: "Skills",
  award: "Awards",
  other: "Highlights",
};

function render({ resume }: ResumeTemplateContext): string {
  const density = pickDensity(resume);
  const visibleItems = resume.items.filter((item) => !item.hidden);
  const sections = groupItemsBySection(visibleItems);
  const sectionsHtml = SECTION_ORDER
    .flatMap((type) => {
      const items = sections.get(type);
      if (!items || items.length === 0) return [];
      return [renderSection(type, items)];
    })
    .join("\n");

  const headerName = escapeHtml(resume.title);
  const headerKicker = resume.targetRole
    ? `<div class="kicker">${escapeHtml(resume.targetRole)}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${headerName}</title>
<style>
${PRINT_CSS}
</style>
</head>
<body>
<main class="resume density-${density}" data-template="one-page-modern" data-density="${density}" role="document">
  <header class="masthead">
    <h1 class="name">${headerName}</h1>
    ${headerKicker}
  </header>
  ${sectionsHtml}
</main>
</body>
</html>`;
}

function pickDensity(resume: ResumeTemplateContext["resume"]): OnePageModernDensity {
  const raw = (resume as { metadata?: Record<string, unknown> }).metadata?.density;
  if (raw === "comfortable" || raw === "standard" || raw === "compact") return raw;
  return DEFAULT_DENSITY;
}

function groupItemsBySection(
  items: ProductResumeItem[],
): Map<ProductResumeItem["sectionType"], ProductResumeItem[]> {
  const map = new Map<ProductResumeItem["sectionType"], ProductResumeItem[]>();
  for (const item of items) {
    const key: ProductResumeItem["sectionType"] = SECTION_ORDER.includes(item.sectionType)
      ? item.sectionType
      : "other";
    const bucket = map.get(key) ?? [];
    bucket.push(item);
    map.set(key, bucket);
  }
  for (const bucket of map.values()) {
    bucket.sort(compareItems);
  }
  return map;
}

function compareItems(a: ProductResumeItem, b: ProductResumeItem): number {
  const sa = numericMetadata(a, "sectionOrder");
  const sb = numericMetadata(b, "sectionOrder");
  if (sa !== sb) return sa - sb;
  return a.orderIndex - b.orderIndex;
}

function numericMetadata(item: ProductResumeItem, key: string): number {
  const value = (item.metadata ?? {})[key];
  return typeof value === "number" && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function stringMetadata(item: ProductResumeItem, key: string): string | undefined {
  const value = (item.metadata ?? {})[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function bulletIdsMetadata(item: ProductResumeItem): string[] {
  const value = (item.metadata ?? {}).bulletIds;
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === "string" && id.length > 0);
}

function renderSection(
  type: ProductResumeItem["sectionType"],
  items: ProductResumeItem[],
): string {
  const label = SECTION_LABELS[type];
  if (type === "skill") return renderSkillSection(label, items);
  if (type === "summary") return renderSummarySection(label, items);
  const body = items.map((item) => renderItem(item)).join("\n");
  return `<section class="section section--${type}" data-section-type="${type}">
  <h2 class="section-title">${escapeHtml(label)}</h2>
  ${body}
</section>`;
}

function renderItem(item: ProductResumeItem): string {
  const parsed = parseContentSnapshot(item.contentSnapshot);
  const headerLine = parsed.header || item.title;
  const headerHtml = renderItemHeader(headerLine, item);
  const dataItemId = stringMetadata(item, "itemId");
  const itemAttrs = dataItemId ? ` data-item-id="${escapeHtml(dataItemId)}"` : "";
  if (parsed.bullets.length === 0) {
    const body = parsed.fallbackBody.trim();
    if (!body) return `<article class="item"${itemAttrs}>${headerHtml}</article>`;
    return `<article class="item"${itemAttrs}>${headerHtml}<p class="item-body">${escapeHtml(body)}</p></article>`;
  }
  const metadataBulletIds = bulletIdsMetadata(item);
  const bullets = parsed.bullets
    .map((b, i) => {
      const bid = metadataBulletIds[i];
      const battr = bid ? ` data-bullet-id="${escapeHtml(bid)}"` : "";
      return `<li${battr}>${escapeHtml(b)}</li>`;
    })
    .join("");
  return `<article class="item"${itemAttrs}>${headerHtml}<ul class="bullets">${bullets}</ul></article>`;
}

function renderItemHeader(headerLine: string, item: ProductResumeItem): string {
  const parts = headerLine
    .split(/\s+\u00B7\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const title = parts[0] || item.title;
  const periodIdx = parts.findIndex((p, idx) => idx > 0 && looksLikePeriod(p));
  const period = periodIdx > 0 ? parts[periodIdx] : "";
  const middle = parts
    .slice(1)
    .filter((_, i) => i + 1 !== periodIdx)
    .join(` ${MIDDOT} `);
  return `<header class="item-header">
    <div class="item-title-row">
      <span class="item-title">${escapeHtml(title)}</span>
      ${period ? `<span class="item-period">${escapeHtml(period)}</span>` : ""}
    </div>
    ${middle ? `<div class="item-meta">${escapeHtml(middle)}</div>` : ""}
  </header>`;
}

function looksLikePeriod(value: string): boolean {
  if (!/\d{4}/.test(value)) return false;
  if (/[\u2013\u2014~]/.test(value)) return true;
  if (/\bto\b/i.test(value)) return true;
  if (/[\u81f3\u5230\u73b0\u4eca]/.test(value)) return true;
  if (/\d\s*-\s*\d/.test(value)) return true;
  if (/\d\s*-\s*[A-Za-z]/.test(value)) return true;
  return false;
}

function renderSummarySection(label: string, items: ProductResumeItem[]): string {
  const paragraphs = items
    .map((item) => {
      const parsed = parseContentSnapshot(item.contentSnapshot);
      const text = parsed.bullets.length > 0
        ? parsed.bullets.join(" ")
        : parsed.fallbackBody.trim();
      return text;
    })
    .filter((t) => t.length > 0)
    .map((t) => `<p class="summary-paragraph">${escapeHtml(t)}</p>`)
    .join("");
  if (!paragraphs) return "";
  return `<section class="section section--summary" data-section-type="summary">
  <h2 class="section-title">${escapeHtml(label)}</h2>
  ${paragraphs}
</section>`;
}

function renderSkillSection(label: string, items: ProductResumeItem[]): string {
  const skills = items.flatMap((item) => {
    const parsed = parseContentSnapshot(item.contentSnapshot);
    if (parsed.bullets.length > 0) return parsed.bullets;
    return parsed.fallbackBody
      .split(/[,\uFF0C;\uFF1B\u3001]/)
      .map((s) => s.trim())
      .filter(Boolean);
  });
  if (skills.length === 0) return "";
  const chips = skills.map((s) => `<span class="skill-chip">${escapeHtml(s)}</span>`).join("");
  return `<section class="section section--skill" data-section-type="skill">
  <h2 class="section-title">${escapeHtml(label)}</h2>
  <p class="skills-line">${chips}</p>
</section>`;
}

type ParsedSnapshot = {
  header: string;
  bullets: string[];
  fallbackBody: string;
};

function parseContentSnapshot(snapshot: string): ParsedSnapshot {
  const lines = (snapshot ?? "").split(/\r?\n/);
  let header = "";
  const bullets: string[] = [];
  const otherLines: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const bulletMatch = /^[-\u2022*]\s+(.*)$/.exec(line);
    if (bulletMatch) {
      bullets.push(bulletMatch[1].trim());
      continue;
    }
    if (header === "" && bullets.length === 0) {
      header = line;
      continue;
    }
    otherLines.push(line);
  }
  return {
    header,
    bullets,
    fallbackBody: [header, ...otherLines].filter(Boolean).join("\n"),
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PRINT_CSS = `
:root {
  --ink: #111827;
  --muted: #4b5563;
  --rule: #e5e7eb;
  --accent: #1f2937;
  --page-width: 210mm;
  --page-height: 297mm;
  --page-margin: 18mm;
}
@page {
  size: A4;
  margin: 18mm;
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  background: #ffffff;
  color: var(--ink);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif;
  font-size: 10.5pt;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.resume {
  max-width: 760px;
  margin: 0 auto;
  padding: 24px;
}
@media print {
  .resume { max-width: none; margin: 0; padding: 0; }
}
.masthead {
  text-align: left;
  border-bottom: 1.5px solid var(--accent);
  padding-bottom: 10px;
  margin-bottom: 14px;
}
.name {
  margin: 0;
  font-size: 22pt;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: var(--accent);
}
.kicker {
  margin-top: 4px;
  color: var(--muted);
  font-size: 11pt;
  font-weight: 500;
}
.section {
  margin-top: 14px;
  page-break-inside: auto;
}
.section-title {
  margin: 0 0 6px 0;
  font-size: 10.5pt;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1.2px;
  color: var(--accent);
  border-bottom: 1px solid var(--rule);
  padding-bottom: 3px;
}
.item {
  margin-top: 10px;
  page-break-inside: avoid;
  break-inside: avoid;
}
.item:first-of-type { margin-top: 4px; }
.item-header { margin-bottom: 2px; }
.item-title-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
}
.item-title {
  font-weight: 600;
  font-size: 11pt;
  color: var(--ink);
}
.item-period {
  font-size: 9.5pt;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.item-meta {
  font-size: 9.5pt;
  color: var(--muted);
  margin-top: 1px;
}
.bullets {
  margin: 4px 0 0 0;
  padding-left: 18px;
  list-style: disc;
}
.bullets li {
  margin: 2px 0;
  page-break-inside: avoid;
  break-inside: avoid;
}
.item-body {
  margin: 4px 0 0 0;
  white-space: pre-wrap;
}
.summary-paragraph {
  margin: 4px 0 0 0;
  color: var(--ink);
}
.section--skill .skills-line {
  margin: 4px 0 0 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
}
.skill-chip {
  display: inline-block;
  font-size: 9.5pt;
  color: var(--ink);
  background: #f3f4f6;
  border: 1px solid var(--rule);
  border-radius: 3px;
  padding: 1px 8px;
  line-height: 1.4;
}

/* ── density modes (Phase 4 reserves these; auto-switching is Phase 5) ── */
.resume.density-comfortable { font-size: 11pt; line-height: 1.6; }
.resume.density-comfortable .item { margin-top: 12px; }
.resume.density-comfortable .bullets li { margin: 3px 0; }

.resume.density-standard { font-size: 10.5pt; line-height: 1.5; }

.resume.density-compact { font-size: 9.75pt; line-height: 1.38; }
.resume.density-compact .section { margin-top: 10px; }
.resume.density-compact .item { margin-top: 7px; }
.resume.density-compact .bullets li { margin: 1px 0; }
.resume.density-compact .name { font-size: 20pt; }
`;
