import type {
  AdviseCoverageGapsInput,
  CoverageGapReport,
} from "./types.js";

export interface CoverageGapAdvisor {
  advise(input: AdviseCoverageGapsInput): Promise<CoverageGapReport>;
}
