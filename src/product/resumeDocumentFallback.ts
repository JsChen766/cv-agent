import { randomUUID } from "node:crypto";
import type { ResumeDocument, ResumeDocumentBullet, ResumeDocumentItem, ResumeDocumentSection } from "./types.js";

/**
 * Heuristic fallback that converts a free-form variant `content` string into
 * a `ResumeDocument` shaped exactly like the LLM-produced one.
 *
 * IMPORTANT: this helper is intentionally NOT wired into the accept/save
 * path (`saveAcceptedVariantToResume`). It exists so future stages
 * (template rendering, fit-engine projection, …) can opt-in to a
 * structured view of legacy variants without forcing the saver to
 * second-guess LLM output. Keep it pure and side-effect-free.
 *
 * Heuristics:
 * - Top-level Markdown headings (`#`, `##`, …) start a new section. The
 *   heading text becomes the section title, and the section type is
 *   inferred from common Chinese / English keywords.
 * - When no heading is found at all, the entire content is wrapped in a
 *   single `experience` section with one item.
 * - Within a section, blank lines split items. The first non-bullet line
 *   of an item is the title; subsequent lines starting with `-`, `•`, or
 *   `*` become bullets. Lines without a bullet prefix are merged into
 *   the title or the previous bullet, whichever is closer.
 * - Empty sections / items are dropped so the result always satisfies
 *   `ResumeDocumentSchema` (sections.length ≥ 1, every item has at
 *   least one non-empty bullet, every bullet text is non-empty).
 *
 * If the input is whitespace-only the function returns `undefined`.
 */
export function buildResumeDocumentFromContent(
  content: string,
  options: { idPrefix?: string } = {},
): ResumeDocument | undefined {
  const text = (content ?? "").trim();
  if (!text) return undefined;
  const idFor = (kind: "sec" | "item" | "b") => `${options.idPrefix ?? "doc"}-${kind}-${randomUUID().slice(0, 8)}`;

  const sections: ResumeDocumentSection[] = [];
  let current: ResumeDocumentSection | null = null;
  let pendingItemLines: string[] = [];

  const flushItem = () => {
    if (!current) return;
    const item = parseItem(pendingItemLines, idFor);
    if (item) current.items.push(item);
    pendingItemLines = [];
  };

  const flushSection = () => {
    flushItem();
    if (current && current.items.length > 0) sections.push(current);
    current = null;
  };

  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const heading = matchHeading(line);
    if (heading) {
      flushSection();
      current = {
        id: idFor("sec"),
        type: inferSectionType(heading),
        title: heading,
        order: sections.length,
        items: [],
      };
      continue;
    }
    if (!current) {
      current = {
        id: idFor("sec"),
        type: "experience",
        title: "Experience",
        order: 0,
        items: [],
      };
    }
    if (line.trim() === "") {
      flushItem();
      continue;
    }
    pendingItemLines.push(line);
  }
  flushSection();

  if (sections.length === 0) {
    // No structure detected at all → wrap the whole thing as one item.
    const fallbackBullets = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map<ResumeDocumentBullet>((l) => ({ id: idFor("b"), text: stripBulletPrefix(l) }));
    if (fallbackBullets.length === 0) return undefined;
    sections.push({
      id: idFor("sec"),
      type: "experience",
      title: "Experience",
      order: 0,
      items: [
        {
          id: idFor("item"),
          title: stripBulletPrefix(fallbackBullets[0].text).slice(0, 80),
          bullets: fallbackBullets,
        },
      ],
    });
  }

  return { schemaVersion: 1, sections };
}

function matchHeading(line: string): string | null {
  const md = /^#{1,6}\s+(.+)$/.exec(line.trim());
  if (md) return md[1].trim();
  return null;
}

function inferSectionType(title: string): ResumeDocumentSection["type"] {
  const lc = title.toLowerCase();
  if (/教育|学历|学位|education|academic/.test(title) || /education|degree|academic/.test(lc)) return "education";
  if (/项目|作品|project|portfolio/.test(title) || /project|portfolio/.test(lc)) return "project";
  if (/技能|工具|tech|skill/.test(title) || /skill|tech|tool/.test(lc)) return "skill";
  if (/奖|荣誉|award|honor/.test(title) || /award|honor|prize/.test(lc)) return "award";
  if (/概述|简介|summary|profile|about/.test(title) || /summary|profile|about/.test(lc)) return "summary";
  if (/经历|工作|experience|employ/.test(title) || /experience|work|employ/.test(lc)) return "experience";
  return "other";
}

function parseItem(
  lines: string[],
  idFor: (kind: "sec" | "item" | "b") => string,
): ResumeDocumentItem | null {
  const cleaned = lines.map((l) => l.trim()).filter((l) => l.length > 0);
  if (cleaned.length === 0) return null;

  const titleLine = cleaned[0];
  const bulletLines: string[] = [];
  for (let i = 1; i < cleaned.length; i += 1) {
    const line = cleaned[i];
    if (isBulletLine(line)) {
      bulletLines.push(stripBulletPrefix(line));
    } else if (bulletLines.length > 0) {
      bulletLines[bulletLines.length - 1] = `${bulletLines[bulletLines.length - 1]} ${line}`.trim();
    } else {
      bulletLines.push(line);
    }
  }

  const bullets: ResumeDocumentBullet[] = bulletLines
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .map((text) => ({ id: idFor("b"), text }));

  if (bullets.length === 0) {
    bullets.push({ id: idFor("b"), text: titleLine });
  }

  return {
    id: idFor("item"),
    title: titleLine.slice(0, 120),
    bullets,
  };
}

function isBulletLine(line: string): boolean {
  return /^[-•*]\s+/.test(line);
}

function stripBulletPrefix(line: string): string {
  return line.replace(/^[-•*]\s+/, "").trim();
}
