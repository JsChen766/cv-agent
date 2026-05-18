import type { ResumeExportRepository } from "./ResumeExportRepository.js";
import type { ResumeExport } from "./types.js";

export class InMemoryResumeExportRepository implements ResumeExportRepository {
  private readonly exports = new Map<string, ResumeExport>();

  public async createExport(record: ResumeExport): Promise<ResumeExport> {
    this.exports.set(record.id, record);
    return record;
  }

  public async getExport(userId: string, id: string): Promise<ResumeExport | null> {
    const record = this.exports.get(id);
    return record?.userId === userId && record.status !== "deleted" ? record : null;
  }

  public async listExports(userId: string, limit = 50): Promise<ResumeExport[]> {
    return Array.from(this.exports.values())
      .filter((record) => record.userId === userId && record.status !== "deleted")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  public async updateExport(userId: string, id: string, patch: Partial<ResumeExport>): Promise<ResumeExport | null> {
    const record = await this.getExport(userId, id);
    if (!record) return null;
    const next = { ...record, ...patch, updatedAt: new Date().toISOString() };
    this.exports.set(id, next);
    return next;
  }
}
