import type { ResumeExport } from "./types.js";

export type ResumeExportRepository = {
  createExport(record: ResumeExport): Promise<ResumeExport>;
  getExport(userId: string, id: string): Promise<ResumeExport | null>;
  listExports(userId: string, limit?: number): Promise<ResumeExport[]>;
  updateExport(userId: string, id: string, patch: Partial<ResumeExport>): Promise<ResumeExport | null>;
};
