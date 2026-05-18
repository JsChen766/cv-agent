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
};
