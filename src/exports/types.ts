import type { ResumeFitReport } from "./ResumeFitService.js";
import type { ResumeCompressionReport } from "./ResumeCompressionService.js";
import type { ResumeFitEditorReport } from "./ResumeLLMFitEditor.js";
import type { ResumeQualityReport } from "./ResumeQualityService.js";

export type ResumeExportFormat = "pdf" | "html" | "docx";
export type ResumeExportStatus = "pending" | "rendering" | "completed" | "failed" | "expired" | "deleted";

export type ResumeExport = {
  id: string;
  userId: string;
  resumeId: string;
  jobId?: string;
  format: ResumeExportFormat;
  templateId?: string;
  status: ResumeExportStatus;
  fileId?: string;
  downloadTokenHash?: string;
  downloadExpiresAt?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  /**
   * Phase 5: layout measurement attached after the HTML is rendered.
   * Present only after the export reaches `completed`. May be undefined
   * for legacy exports created before Phase 5.
   */
  fitReport?: ResumeFitReport;
  /**
   * Phase 6: rule-based compression record describing what (if anything)
   * the Fit Engine v2 mutated to make the resume fit one page. Present
   * only when the export ran the compression path (i.e. one-page-modern
   * + targetPages=1 + initial overflowPx > 0). May be undefined for any
   * older export, or for exports that fit on first measure.
   */
  compressionReport?: ResumeCompressionReport;
  /**
   * Phase 7: LLM-driven fit editor record. Present only when the export
   * pipeline invoked `ResumeLLMFitEditor` — that is, only when (a) Phase 6
   * compression ran and exhausted its strategies but the resume STILL
   * overflows, OR (b) the page fits but uses too little space (large
   * underflow). The editor is opt-in via `ENABLE_LLM_FIT_EDITOR=true` and
   * a configured frontDeskModelClient; otherwise this field is undefined.
   */
  editReport?: ResumeFitEditorReport;
  /**
   * Phase 8: deterministic resume quality report. Always populated when the
   * export reaches `status="completed"`. Phase 8 is warn-only — no risk
   * level, including `critical`, will block export. Risks of level
   * `critical` may be surfaced to the UI for explicit user attention.
   */
  qualityReport?: ResumeQualityReport;
};
