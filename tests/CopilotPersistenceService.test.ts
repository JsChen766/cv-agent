import { describe, expect, it } from "vitest";
import { InMemoryCopilotPersistence } from "../src/copilot/persistence/index.js";
import { CopilotSessionService, CopilotWorkspaceService } from "../src/copilot/services/index.js";
import {
  ExperienceService,
  GenerationProductService,
  ImportService,
  InMemoryProductExperienceRepository,
  InMemoryProductGenerationRepository,
  InMemoryProductImportRepository,
  InMemoryProductJDRepository,
  InMemoryProductResumeRepository,
  JDService,
  ResumeService,
} from "../src/product/index.js";
import { DefaultCvAgentKernel } from "../src/kernel/index.js";

describe("Copilot persistence services", () => {
  it("creates lists and restores sessions messages turns workspace and activity in memory", async () => {
    const persistence = new InMemoryCopilotPersistence();
    const sessionService = new CopilotSessionService(persistence);
    const workspaceService = new CopilotWorkspaceService(persistence, createProductServices());

    const session = await sessionService.getOrCreateSession("user-1", { targetRole: "FE" });
    expect((await sessionService.getSession("user-1", session.id))?.id).toBe(session.id);
    expect((await sessionService.listSessions("user-1")).map((item) => item.id)).toContain(session.id);

    const userMessage = await sessionService.saveMessage("user-1", {
      id: "msg-user",
      sessionId: session.id,
      role: "user",
      kind: "plain_text",
      content: "Hello",
      createdAt: new Date().toISOString(),
    });
    const turn = await sessionService.createTurn("user-1", session.id, userMessage.id);
    const assistantMessage = await sessionService.saveMessage("user-1", {
      id: "msg-assistant",
      sessionId: session.id,
      turnId: turn.id,
      role: "assistant",
      kind: "plain_text",
      content: "Hi",
      createdAt: new Date().toISOString(),
    });
    await sessionService.completeTurn("user-1", turn.id, assistantMessage.id);

    await workspaceService.saveWorkspace("user-1", {
      id: `ws-${session.id}`,
      sessionId: session.id,
      variants: [],
      status: "empty",
      updatedAt: new Date().toISOString(),
    });
    await workspaceService.recordActivity("user-1", {
      sessionId: session.id,
      type: "chat",
      title: "Copilot chat",
    });

    expect(await sessionService.listMessages("user-1", session.id)).toHaveLength(2);
    expect((await sessionService.listTurns("user-1", session.id))[0]?.status).toBe("completed");
    expect((await workspaceService.getWorkspace("user-1", session.id))?.status).toBe("empty");
    expect((await workspaceService.getSidebar("user-1")).recentActivities).toHaveLength(1);
  });
});

function createProductServices() {
  const experienceService = new ExperienceService(new InMemoryProductExperienceRepository());
  const jdService = new JDService(new InMemoryProductJDRepository());
  const resumeService = new ResumeService(new InMemoryProductResumeRepository());
  const importService = new ImportService(new InMemoryProductImportRepository(), experienceService);
  const cvAgentKernel = new DefaultCvAgentKernel({
    mode: "in_memory",
    warnings: [],
    frontDeskOrchestrator: {} as never,
    resumeGenerationService: {} as never,
    evidenceChainQueryService: {} as never,
    graphViewQueryService: {} as never,
    artifactRevisionService: {} as never,
    artifactDecisionService: {} as never,
    close: async () => {},
  });
  const generationProductService = new GenerationProductService(
    new InMemoryProductGenerationRepository(),
    jdService,
    resumeService,
    cvAgentKernel,
  );
  return { experienceService, jdService, resumeService, importService, generationProductService };
}
