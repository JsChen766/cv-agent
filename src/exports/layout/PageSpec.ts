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
  marginTopMm: 18,
  marginRightMm: 18,
  marginBottomMm: 18,
  marginLeftMm: 18,
  marginPx: {
    top: mmToPx(18),
    right: mmToPx(18),
    bottom: mmToPx(18),
    left: mmToPx(18),
  },
  contentWidthPx: 794 - mmToPx(18) * 2,
  usableHeightPx: 1123 - mmToPx(18) * 2,
  bulletMinLineWidthRatio: 2 / 3,
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
