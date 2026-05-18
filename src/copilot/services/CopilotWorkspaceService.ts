import { randomUUID } from "node:crypto";
import type { ProductServices } from "../../product/index.js";
import type { ProductGeneration } from "../../product/types.js";
import type { CopilotWorkspace } from "../types.js";
import type { CopilotActivity, CopilotActivityType, CopilotPersistence } from "../persistence/index.js";

export type CopilotSidebarReadModel = {
  recentSessions: Array<{ id: string; title?: string | null; updatedAt: string; targetRole?: string | null; status?: string }>;
  recentResumes: Awaited<ReturnType<ProductServices["resumeService"]["listResumes"]>>;
  recentJDs: Awaited<ReturnType<ProductServices["jdService"]["listJDs"]>>;
  recentExperiences: Awaited<ReturnType<ProductServices["experienceService"]["listExperiences"]>>;
  recentGenerations: Array<{ id: string; targetRole?: string; jdId?: string; resumeId?: string; createdAt: string }>;
  recentActivities: Array<{ id: string; type: CopilotActivityType; title: string; description?: string | null; createdAt: string }>;
};

export type ProductDashboardReadModel = CopilotSidebarReadModel & {
  experienceCount: number;
  resumeCount: number;
  jdCount: number;
  generationCount: number;
};

export class CopilotWorkspaceService {
  public constructor(
    private readonly persistence: CopilotPersistence,
    private readonly productServices: ProductServices,
  ) {}

  public async saveWorkspace(userId: string, workspace: CopilotWorkspace): Promise<CopilotWorkspace> {
    const saved = await this.persistence.workspaces.upsertWorkspace(userId, workspace);
    await this.persistence.sessions.updateSession(userId, workspace.sessionId, {
      currentWorkspaceId: workspace.id,
      updatedAt: workspace.updatedAt,
    });
    return saved;
  }

  public getWorkspace(userId: string, sessionId: string): Promise<CopilotWorkspace | null> {
    return this.persistence.workspaces.getWorkspace(userId, sessionId);
  }

  public async recordActivity(userId: string, input: {
    sessionId?: string | null;
    type: CopilotActivityType;
    title: string;
    description?: string | null;
    entityType?: CopilotActivity["entityType"];
    entityId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<CopilotActivity> {
    return this.persistence.activities.createActivity({
      id: `cact-${randomUUID()}`,
      userId,
      sessionId: input.sessionId ?? null,
      type: input.type,
      title: input.title,
      description: input.description ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      metadata: input.metadata,
      createdAt: new Date().toISOString(),
    });
  }

  public async getSidebar(userId: string): Promise<CopilotSidebarReadModel> {
    const [recentSessions, recentResumes, recentJDs, recentExperiences, generations, activities] = await Promise.all([
      this.persistence.sessions.listSessions(userId, { limit: 30 }),
      this.productServices.resumeService.listResumes(userId, 20),
      this.productServices.jdService.listJDs(userId, 20),
      this.productServices.experienceService.listExperiences(userId, { limit: 20 }),
      this.productServices.generationProductService.listGenerations(userId, 20),
      this.persistence.activities.listActivities(userId, { limit: 30 }),
    ]);

    return {
      recentSessions: recentSessions.map((session) => ({
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        targetRole: session.targetRole,
        status: session.status,
      })),
      recentResumes,
      recentJDs,
      recentExperiences,
      recentGenerations: generations.map(toGenerationSummary),
      recentActivities: activities.map((activity) => ({
        id: activity.id,
        type: activity.type,
        title: activity.title,
        description: activity.description,
        createdAt: activity.createdAt,
      })),
    };
  }

  public async getDashboard(userId: string): Promise<ProductDashboardReadModel> {
    const sidebar = await this.getSidebar(userId);
    const [experiences, resumes, jds, generations] = await Promise.all([
      this.productServices.experienceService.listExperiences(userId, { limit: 1000 }),
      this.productServices.resumeService.listResumes(userId, 1000),
      this.productServices.jdService.listJDs(userId, 1000),
      this.productServices.generationProductService.listGenerations(userId, 1000),
    ]);
    return {
      ...sidebar,
      experienceCount: experiences.length,
      resumeCount: resumes.length,
      jdCount: jds.length,
      generationCount: generations.length,
    };
  }
}

function toGenerationSummary(generation: ProductGeneration): { id: string; targetRole?: string; jdId?: string; resumeId?: string; createdAt: string } {
  return {
    id: generation.id,
    targetRole: generation.targetRole,
    jdId: generation.jdId,
    resumeId: generation.resumeId,
    createdAt: generation.createdAt,
  };
}
