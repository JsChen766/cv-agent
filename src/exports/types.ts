import type { ResumeFitReport } from "./ResumeFitService.js";

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
};
