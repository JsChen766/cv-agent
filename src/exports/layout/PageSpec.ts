export type ResumePageSpec = {
  page: "A4";
  pageWidthPx: number;
  pageHeightPx: number;
  marginTopMm: number;
  marginRightMm: number;
  marginBottomMm: number;
  marginLeftMm: number;
  marginPx: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  contentWidthPx: number;
  usableHeightPx: number;
  bulletMinLineWidthRatio: number;
  maxBulletLines: number;
  defaultDensity: "comfortable" | "standard" | "compact";
  targetPages: number;
};

const PX_PER_MM = 96 / 25.4;

function mmToPx(mm: number): number {
  return Math.round(mm * PX_PER_MM);
}

export const A4_ONE_PAGE_SPEC: ResumePageSpec = {
  page: "A4",
  pageWidthPx: 794,
  pageHeightPx: 1123,
  marginTopMm: 8,
  marginRightMm: 8,
  marginBottomMm: 8,
  marginLeftMm: 8,
  marginPx: {
    top: mmToPx(8),
    right: mmToPx(8),
    bottom: mmToPx(8),
    left: mmToPx(8),
  },
  contentWidthPx: 794 - mmToPx(8) * 2,
  usableHeightPx: 1123 - mmToPx(8) * 2,
  bulletMinLineWidthRatio: 0.8,
  maxBulletLines: 2,
  defaultDensity: "standard",
  targetPages: 1,
};

export function pdfMarginOptions(spec: ResumePageSpec = A4_ONE_PAGE_SPEC): {
  top: string;
  right: string;
  bottom: string;
  left: string;
} {
  return {
    top: `${spec.marginTopMm}mm`,
    right: `${spec.marginRightMm}mm`,
    bottom: `${spec.marginBottomMm}mm`,
    left: `${spec.marginLeftMm}mm`,
  };
}
