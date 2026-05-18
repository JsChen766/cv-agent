import type { ApiKernel } from "../../api/types.js";
import type { CopilotSession } from "../../copilot/types.js";
import type { KernelRequestContext } from "../../kernel/context.js";

export class ResumeIngestionCoordinator {
  public constructor(private readonly kernel: ApiKernel) {}

  public async ingestResumeIfNeeded(ctx: KernelRequestContext, session: CopilotSession, warnings: string[]): Promise<void> {
    if (!session.resumeText || session.resumeIngested) return;
    try {
      const result = await this.kernel.cvAgentKernel.documents.ingest(ctx, {
        message: "Import resume.",
        documents: [{
          userId: ctx.user.id,
          fileName: "copilot-resume.txt",
          mimeType: "text/plain",
          sourceRef: `copilot:${session.id}`,
          buffer: new TextEncoder().encode(session.resumeText),
        }],
      });
      await this.kernel.copilotServices.sessionService.updateSession(ctx.user.id, session.id, {
        resumeIngested: true,
        resumeDocumentIds: result.extractedDocuments.map((document) => document.documentId),
        resumeArtifactIds: result.evidences.map((evidence) => evidence.id),
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      warnings.push(`Resume ingestion failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
}
