import { createHash } from "node:crypto";
import type { ProductResumeItem, ResumeDocument } from "../types.js";
import type { ResumeLayoutReport } from "../../exports/layout/ResumeLayoutOracle.js";
import type { LayoutPreviewDiagnostic, LayoutPreviewReport } from "./types.js";

const DEFAULT_UNDERFILL_RATIO = 0.22;

export class LayoutPreviewReportProjector {
  public project(input: {
    resumeDocumentDraft: ResumeDocument;
    layoutReport: ResumeLayoutReport;
    requiredSectionTypes?: ProductResumeItem["sectionType"][];
  }): LayoutPreviewReport {
    const diagnostics: LayoutPreviewDiagnostic[] = [];
    const report = input.layoutReport;
    if (report.overflowPx > 0 || !report.fitsPage) {
      diagnostics.push({
        type: "overflow",
        severity: report.overflowPx > 96 ? "high" : "medium",
        message: `Layout exceeds target page by ${report.overflowPx}px.`,
        overflowPx: report.overflowPx,
      });
    }
    if (report.fitsPage && report.remainingHeightPx > Math.round(report.usableHeightPx * DEFAULT_UNDERFILL_RATIO)) {
      diagnostics.push({
        type: "underfill",
        severity: "low",
        message: `Layout leaves ${report.remainingHeightPx}px unused on the target page.`,
        remainingHeightPx: report.remainingHeightPx,
      });
    }
    for (const bullet of report.invalidBullets) {
      if (bullet.lineCount > report.maxBulletLines) {
        diagnostics.push({
          type: "excessive_bullet_lines",
          severity: "medium",
          message: `Bullet uses ${bullet.lineCount} lines, exceeding the ${report.maxBulletLines}-line limit.`,
          itemId: bullet.itemId,
          bulletId: bullet.bulletId,
          lineCount: bullet.lineCount,
        });
      }
      const shortestLine = bullet.lineWidthsPx.length > 0 ? Math.min(...bullet.lineWidthsPx) : 0;
      if (shortestLine < bullet.minRequiredLineWidthPx) {
        diagnostics.push({
          type: "short_bullet_line",
          severity: "medium",
          message: `Bullet has a short line below ${bullet.minRequiredLineWidthPx}px.`,
          itemId: bullet.itemId,
          bulletId: bullet.bulletId,
          minLineWidthPx: bullet.minRequiredLineWidthPx,
        });
      }
    }
    const existingTypes = new Set(input.resumeDocumentDraft.sections.map((section) => section.type));
    const missingSections = (input.requiredSectionTypes ?? [])
      .filter((sectionType) => !existingTypes.has(sectionType));
    for (const sectionType of missingSections) {
      diagnostics.push({
        type: "missing_section",
        severity: "medium",
        message: `Resume preview is missing a ${sectionType} section.`,
        sectionType,
      });
    }
    return {
      schemaVersion: 1,
      layoutPreviewId: stableId("rlp", [report.layoutSessionId, report.templateId, String(report.measuredAt)]),
      generatedAt: report.measuredAt,
      exportLayoutReport: report,
      summary: {
        fitsPage: report.fitsPage,
        hasOverflow: report.overflowPx > 0 || !report.fitsPage,
        hasUnderfill: diagnostics.some((item) => item.type === "underfill"),
        invalidBulletCount: report.invalidBullets.length,
        missingSectionCount: missingSections.length,
      },
      diagnostics,
    };
  }
}

function stableId(prefix: string, parts: string[]): string {
  const hash = createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 16);
  return `${prefix}-${hash}`;
}
