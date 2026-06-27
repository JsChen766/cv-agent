import type { ProductResumeItem } from "../../product/types.js";
import { A4_ONE_PAGE_SPEC } from "../layout/PageSpec.js";
import type { ResumeTemplate, ResumeTemplateContext } from "./defaultTemplate.js";

export type OnePageModernDensity = "comfortable" | "standard" | "compact";

export function onePageModernTemplate(): ResumeTemplate {
  return {
    id: "one-page-modern",
    name: "One Page Modern",
    render,
  };
}

const MIDDOT = "\u00B7";
const PAGE = A4_ONE_PAGE_SPEC;
const DEFAULT_DENSITY: OnePageModernDensity = PAGE.defaultDensity;

const SECTION_ORDER: ProductResumeItem["sectionType"][] = [
  "education",
  "experience",
  "project",
  "award",
  "skill",
  "summary",
  "other",
];

const SECTION_LABELS_EN: Record<ProductResumeItem["sectionType"], string> = {
  summary: "Summary",
  experience: "Experience",
  project: "Projects",
  education: "Education",
  skill: "Skills",
  award: "Awards",
  other: "Highlights",
};

const SECTION_LABELS_ZH: Record<ProductResumeItem["sectionType"], string> = {
  summary: "个人总结",
  experience: "实习经历",
  project: "项目经历",
  education: "教育经历",
  skill: "技能与兴趣",
  award: "荣誉奖项",
  other: "其他亮点",
};

function render({ resume }: ResumeTemplateContext): string {
  const density = pickDensity(resume);
  const visibleItems = resume.items.filter((item) => !item.hidden);
  const sections = groupItemsBySection(visibleItems);
  const labels = usesChineseLabels(resume, visibleItems) ? SECTION_LABELS_ZH : SECTION_LABELS_EN;
  const sectionsHtml = SECTION_ORDER
    .flatMap((type) => {
      const items = sections.get(type);
      if (!items || items.length === 0) return [];
      return [renderSection(type, items, labels)];
    })
    .join("\n");

  const metadata = (resume as { metadata?: Record<string, unknown> }).metadata ?? {};
  const profile = profileFromMetadata(metadata);
  const headerName = escapeHtml(profile.name ?? cleanResumeTitle(resume.title, resume.targetRole));
  const roleText = profile.name && resume.targetRole ? resume.targetRole : cleanTargetRole(resume.targetRole, resume.title);
  const headerKicker = roleText
    ? `<div class="kicker">${escapeHtml(roleText)}</div>`
    : "";
  const contactHtml = renderContact(profile.contact);

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
    <div class="identity">
      <h1 class="name">${headerName}</h1>
      ${headerKicker}
    </div>
    ${contactHtml}
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

function usesChineseLabels(
  resume: ResumeTemplateContext["resume"],
  items: ProductResumeItem[],
): boolean {
  const text = [
    resume.title,
    resume.targetRole,
    ...items.flatMap((item) => [item.title, item.contentSnapshot]),
  ].filter(Boolean).join("\n");
  return /[\u3400-\u9FFF]/u.test(text);
}

type HeaderProfile = {
  name?: string;
  contact: string[];
};

function profileFromMetadata(metadata: Record<string, unknown>): HeaderProfile {
  const candidateName = stringValue(metadata.candidateName)
    ?? stringValue(metadata.name)
    ?? stringValue(metadata.fullName);
  const contactRaw = metadata.contact;
  const contact: string[] = [];
  if (Array.isArray(contactRaw)) {
    contact.push(...contactRaw.filter((item): item is string => typeof item === "string" && item.trim().length > 0));
  } else if (contactRaw && typeof contactRaw === "object") {
    for (const value of Object.values(contactRaw as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim().length > 0) contact.push(value.trim());
    }
  }
  for (const key of ["phone", "email", "website", "location"]) {
    const value = stringValue(metadata[key]);
    if (value) contact.push(value);
  }
  return { name: candidateName, contact: Array.from(new Set(contact)).slice(0, 5) };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function cleanResumeTitle(title: string, targetRole?: string): string {
  const cleaned = title
    .replace(/\s+(?:draft|resume)\s*$/i, "")
    .replace(/\s+简历草稿\s*$/u, "")
    .trim();
  if (cleaned) return cleaned;
  return targetRole?.trim() || "Resume";
}

function cleanTargetRole(targetRole: string | undefined, title: string): string | undefined {
  const cleanedTitle = cleanResumeTitle(title, targetRole);
  const role = targetRole?.trim();
  if (!role || role === cleanedTitle) return undefined;
  return role;
}

function renderContact(contact: string[]): string {
  if (contact.length === 0) return "";
  return `<address class="contact">${contact.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</address>`;
}

function renderSection(
  type: ProductResumeItem["sectionType"],
  items: ProductResumeItem[],
  labels: Record<ProductResumeItem["sectionType"], string>,
): string {
  const label = labels[type];
  if (type === "skill") return renderSkillSection(label, items);
  if (type === "award") return renderInlineInfoSection(type, label, items);
  if (type === "summary") return renderSummarySection(label, items);
  if (type === "education") return renderInfoSection(type, label, items);
  const body = items.map((item) => renderItem(item)).join("\n");
  const sectionId = sectionIdFor(type, items);
  return `<section class="section section--${type}" data-section-type="${type}" data-section-id="${escapeHtml(sectionId)}">
  <h2 class="section-title">${escapeHtml(label)}</h2>
  ${body}
</section>`;
}

function renderInfoSection(
  type: ProductResumeItem["sectionType"],
  label: string,
  items: ProductResumeItem[],
): string {
  const body = items.map((item) => {
    const parsed = parseContentSnapshot(item.contentSnapshot);
    const headerLine = parsed.header || item.title;
    const headerHtml = renderItemHeader(headerLine, item);
    const dataItemId = stringMetadata(item, "itemId");
    const stableItemId = dataItemId ?? item.id;
    const itemAttrs = ` data-item-id="${escapeHtml(stableItemId)}"`;
    const details = [...parsed.bullets, ...parsed.bodyLines]
      .flatMap((value) => value.split(/\r?\n/))
      .map((value) => value.trim())
      .filter(Boolean);
    const detailHtml = details.length > 0
      ? `<p class="item-body">${escapeHtml(details.join(" · "))}</p>`
      : "";
    return `<article class="item"${itemAttrs}>${headerHtml}${detailHtml}</article>`;
  }).join("\n");
  const sectionId = sectionIdFor(type, items);
  return `<section class="section section--${type}" data-section-type="${type}" data-section-id="${escapeHtml(sectionId)}">
  <h2 class="section-title">${escapeHtml(label)}</h2>
  ${body}
</section>`;
}

function renderItem(item: ProductResumeItem): string {
  const parsed = parseContentSnapshot(item.contentSnapshot);
  const headerLine = parsed.header || item.title;
  const headerHtml = renderItemHeader(headerLine, item);
  const dataItemId = stringMetadata(item, "itemId");
  const stableItemId = dataItemId ?? item.id;
  const itemAttrs = ` data-item-id="${escapeHtml(stableItemId)}"`;
  if (parsed.bullets.length === 0) {
    const body = parsed.bodyLines.join("\n").trim() || (parsed.header !== item.title ? parsed.header : "");
    if (!body) return `<article class="item"${itemAttrs}>${headerHtml}</article>`;
    return `<article class="item"${itemAttrs}>${headerHtml}<p class="item-body">${escapeHtml(body)}</p></article>`;
  }
  const metadataBulletIds = bulletIdsMetadata(item);
  const bullets = parsed.bullets
    .map((b, i) => {
      const bid = metadataBulletIds[i] ?? `${stableItemId}-bullet-${i + 1}`;
      const battr = ` data-bullet-id="${escapeHtml(bid)}"`;
      return `<li${battr}>${escapeHtml(normalizeBulletText(b))}</li>`;
    })
    .join("");
  return `<article class="item"${itemAttrs}>${headerHtml}<ul class="bullets">${bullets}</ul></article>`;
}

function normalizeBulletText(value: string): string {
  const trimmed = value.trim();
  const labelMatch = /^([\u3400-\u9FFFA-Za-z0-9\s/+&.-]{2,14})[:\uFF1A]\s*(.{24,})$/u.exec(trimmed);
  if (!labelMatch) return trimmed;
  return labelMatch[2].trim();
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
  return `<section class="section section--summary" data-section-type="summary" data-section-id="${escapeHtml(sectionIdFor("summary", items))}">
  <h2 class="section-title">${escapeHtml(label)}</h2>
  ${paragraphs}
</section>`;
}

function renderSkillSection(label: string, items: ProductResumeItem[]): string {
  const skills = items.flatMap((item) => {
    const parsed = parseContentSnapshot(item.contentSnapshot);
    if (parsed.bullets.length > 0) return parsed.bullets;
    const source = parsed.bodyLines.length > 0 ? parsed.bodyLines.join("；") : parsed.header;
    return source
      .split(/[,\uFF0C;\uFF1B\u3001]/)
      .map((s) => s.trim())
      .filter(Boolean);
  });
  if (skills.length === 0) return "";
  const line = skills.map((s) => escapeHtml(s)).join("、");
  return `<section class="section section--skill" data-section-type="skill" data-section-id="${escapeHtml(sectionIdFor("skill", items))}">
  <h2 class="section-title">${escapeHtml(label)}</h2>
  <p class="skills-line">${line}</p>
</section>`;
}

function renderInlineInfoSection(
  type: ProductResumeItem["sectionType"],
  label: string,
  items: ProductResumeItem[],
): string {
  const entries = items
    .map((item) => {
      const parsed = parseContentSnapshot(item.contentSnapshot);
      const header = parsed.header || item.title;
      const details = [...parsed.bullets, ...parsed.bodyLines]
        .flatMap((value) => value.split(/\r?\n/))
        .map((value) => normalizeBulletText(value.trim()))
        .filter(Boolean);
      return [header, ...details].filter(Boolean).join(" · ");
    })
    .filter(Boolean);
  if (entries.length === 0) return "";
  const line = entries.map((entry) => escapeHtml(entry)).join("；");
  return `<section class="section section--${type} section--inline-info" data-section-type="${type}" data-section-id="${escapeHtml(sectionIdFor(type, items))}">
  <h2 class="section-title">${escapeHtml(label)}</h2>
  <p class="inline-info-line">${line}</p>
</section>`;
}

function sectionIdFor(type: ProductResumeItem["sectionType"], items: ProductResumeItem[]): string {
  const explicit = items
    .map((item) => stringMetadata(item, "sectionId"))
    .find(Boolean);
  return explicit ?? `section-${type}`;
}

type ParsedSnapshot = {
  header: string;
  bullets: string[];
  fallbackBody: string;
  bodyLines: string[];
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
    bodyLines: otherLines,
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
  --page-width: ${PAGE.pageWidthPx}px;
  --page-height: ${PAGE.pageHeightPx}px;
  --content-width: ${PAGE.contentWidthPx}px;
  --usable-height: ${PAGE.usableHeightPx}px;
  --page-margin-top: ${PAGE.marginTopMm}mm;
  --page-margin-right: ${PAGE.marginRightMm}mm;
  --page-margin-bottom: ${PAGE.marginBottomMm}mm;
  --page-margin-left: ${PAGE.marginLeftMm}mm;
}
@page {
  size: A4;
  margin: ${PAGE.marginTopMm}mm ${PAGE.marginRightMm}mm ${PAGE.marginBottomMm}mm ${PAGE.marginLeftMm}mm;
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  background: #ffffff;
  color: var(--ink);
  font-family: "Noto Sans CJK SC", "Noto Sans SC", "Source Han Sans SC", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  font-size: 9.4pt;
  line-height: 1.4;
  -webkit-font-smoothing: antialiased;
}
.resume {
  max-width: 760px;
  margin: 0 auto;
  padding: 16px;
}
@media print {
  .resume { max-width: none; margin: 0; padding: 0; }
}
.masthead {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  text-align: left;
  border-bottom: 1px solid var(--accent);
  padding-bottom: 2px;
  margin-bottom: 3px;
}
.identity { min-width: 0; }
.name {
  margin: 0;
  font-size: 18pt;
  font-weight: 600;
  letter-spacing: 0;
  color: var(--accent);
  line-height: 1.05;
}
.kicker {
  margin-top: 1px;
  color: var(--muted);
  font-size: 8.8pt;
  font-weight: 500;
}
.contact {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
  margin: 0;
  color: var(--ink);
  font-style: normal;
  font-size: 8pt;
  line-height: 1.18;
  white-space: nowrap;
}
.section {
  margin-top: 4px;
  page-break-inside: auto;
}
.section-title {
  margin: 0 0 2px 0;
  font-size: 9pt;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0;
  color: var(--accent);
  border-bottom: 1px solid var(--accent);
  padding-bottom: 1px;
}
.item {
  margin-top: 3px;
  page-break-inside: avoid;
  break-inside: avoid;
}
.item:first-of-type { margin-top: 1px; }
.item-header { margin-bottom: 0; }
.item-title-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}
.item-title {
  font-weight: 600;
  font-size: 9.1pt;
  color: var(--ink);
}
.item-period {
  font-size: 8.3pt;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.item-meta {
  font-size: 8.3pt;
  color: var(--muted);
  margin-top: 0;
}
.bullets {
  margin: 1px 0 0 0;
  padding-left: 0;
  list-style: none;
}
.bullets li {
  position: relative;
  margin: 0;
  padding-left: 9px;
  page-break-inside: avoid;
  break-inside: avoid;
  text-align: left;
  letter-spacing: 0;
  word-spacing: normal;
}
.bullets li::before {
  content: "";
  position: absolute;
  left: 1px;
  top: 0.74em;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--ink);
  transform: translateY(-50%);
}
.item-body {
  margin: 1px 0 0 0;
  white-space: pre-wrap;
}
.summary-paragraph {
  margin: 1px 0 0 0;
  color: var(--ink);
}
.section--skill .skills-line {
  margin: 1px 0 0 0;
  display: block;
  font-size: 8.4pt;
  color: var(--ink);
  line-height: 1.2;
}
.section--inline-info .inline-info-line {
  margin: 1px 0 0 0;
  display: block;
  font-size: 8.4pt;
  color: var(--ink);
  line-height: 1.2;
}

/* ── density modes (Phase 4 reserves these; auto-switching is Phase 5) ── */
.resume.density-comfortable { font-size: 11pt; line-height: 1.6; }
.resume.density-comfortable .item { margin-top: 12px; }
.resume.density-comfortable .bullets li { margin: 3px 0; }

.resume.density-standard { font-size: 9.4pt; line-height: 1.52; }

.resume.density-compact { font-size: 9.2pt; line-height: 1.26; }
.resume.density-compact .section { margin-top: 4px; }
.resume.density-compact .item { margin-top: 3px; }
.resume.density-compact .bullets li { margin: 0; }
.resume.density-compact .name { font-size: 17.5pt; }
`;
