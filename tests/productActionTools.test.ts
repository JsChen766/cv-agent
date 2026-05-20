import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKernel } from "../src/api/kernel/createKernel.js";
import type { ApiKernel } from "../src/api/types.js";
import { AgentToolRegistry } from "../src/agents/tools/AgentToolRegistry.js";
import type { AgentToolExecutionContext } from "../src/agents/tools/AgentToolTypes.js";
import { createTestKernelContext } from "../src/kernel/context.js";

describe("product action tools", () => {
  let kernel: ApiKernel;
  let registry: AgentToolRegistry;

  beforeEach(async () => {
    process.env.NODE_ENV = "test";
    process.env.AUTH_MODE = "dev_header";
    process.env.AGENT_PROVIDER = "mock";
    process.env.FRONTDESK_AGENT_MODE = "mock";
    process.env.EXPERIENCE_EXTRACTOR_MODE = "deterministic";
    process.env.ARTIFACT_GENERATOR_MODE = "deterministic";
    process.env.CRITIC_AGENT_MODE = "deterministic";
    process.env.REVISION_AGENT_MODE = "deterministic";
    delete process.env.DATABASE_URL;
    kernel = await createKernel();
    registry = new AgentToolRegistry(kernel);
  });

  afterEach(async () => {
    await kernel.close();
  });

  it("export_resume returns needs_input and actionResult when resumeId is missing", async () => {
    const result = await registry.execute("export_resume", {}, await toolContext(kernel));

    expect(result.status).toBe("needs_input");
    expect(result.actionResult).toMatchObject({
      actionType: "export_resume",
      status: "needs_input",
      missingInputs: ["resumeId"],
    });
  });

  it("export_resume returns export actionResult, workspace patch, and export_created timeline", async () => {
    const resume = await kernel.productServices.resumeService.createResume("user-1", { title: "Frontend draft" });
    const result = await registry.execute("export_resume", { resumeId: resume.id, format: "html" }, await toolContext(kernel));

    expect(result.status).toBe("success");
    expect(result.actionResult).toMatchObject({
      actionType: "export_resume",
      status: "success",
      exportRecord: expect.objectContaining({
        id: expect.stringMatching(/^export-/),
        resumeId: resume.id,
        format: "html",
        status: "pending",
        jobId: expect.stringMatching(/^job-/),
      }),
    });
    expect(result.workspacePatch).toMatchObject({
      activeExportId: expect.stringMatching(/^export-/),
      exportRecords: [expect.objectContaining({ resumeId: resume.id, format: "html" })],
    });
    expect(result.timelineItems?.[0]).toMatchObject({
      type: "export_created",
      title: "Resume export created",
      relatedExportId: expect.stringMatching(/^export-/),
    });
  });

  it("optimize_resume_item returns needs_input and actionResult when text is missing", async () => {
    const result = await registry.execute("optimize_resume_item", {}, await toolContext(kernel));

    expect(result.status).toBe("needs_input");
    expect(result.actionResult).toMatchObject({
      actionType: "optimize_resume_item",
      status: "needs_input",
      missingInputs: ["selectedText", "resumeItemId"],
    });
  });

  it("optimize_resume_item returns revisionSuggestion for selectedText", async () => {
    const result = await registry.execute("optimize_resume_item", {
      selectedText: "Built React systems for internal users.",
      resumeItemId: "item-1",
      instruction: "make_more_quantified",
    }, await toolContext(kernel));

    expect(result.status).toBe("success");
    expect(result.actionResult).toMatchObject({
      actionType: "optimize_resume_item",
      status: "success",
      revisionSuggestion: expect.objectContaining({
        kind: "resume_item",
        sourceId: "item-1",
        sourceTextPreview: "Built React systems for internal users.",
        usedModel: true,
      }),
    });
    expect(result.actionResult?.revisionSuggestion?.rewrittenText?.length).toBeGreaterThan(0);
  });

  it("rewrite_experience returns needs_input and actionResult when text is missing", async () => {
    const result = await registry.execute("rewrite_experience", {}, await toolContext(kernel));

    expect(result.status).toBe("needs_input");
    expect(result.actionResult).toMatchObject({
      actionType: "rewrite_experience",
      status: "needs_input",
      missingInputs: ["selectedText", "experienceId"],
    });
  });

  it("rewrite_experience returns revisionSuggestion for selectedText", async () => {
    const result = await registry.execute("rewrite_experience", {
      selectedText: "Led frontend migration from legacy stack.",
      experienceId: "exp-1",
    }, await toolContext(kernel));

    expect(result.status).toBe("success");
    expect(result.actionResult).toMatchObject({
      actionType: "rewrite_experience",
      status: "success",
      revisionSuggestion: expect.objectContaining({
        kind: "experience",
        sourceId: "exp-1",
        sourceTextPreview: "Led frontend migration from legacy stack.",
        usedModel: true,
      }),
    });
  });

  it("falls back without throwing when model client fails", async () => {
    kernel.frontDeskModelClient = {
      chat: async () => {
        throw new Error("model unavailable");
      },
    } as unknown as ApiKernel["frontDeskModelClient"];
    registry = new AgentToolRegistry(kernel);

    const result = await registry.execute("optimize_resume_item", {
      selectedText: "Built React systems for internal users.",
      instruction: "make_more_conservative",
    }, await toolContext(kernel));

    expect(result.status).toBe("success");
    expect(result.actionResult?.revisionSuggestion?.usedModel).toBe(false);
    expect(result.actionResult?.revisionSuggestion?.rewrittenText).toContain("Suggestion:");
  });
});

async function toolContext(kernel: ApiKernel): Promise<AgentToolExecutionContext> {
  const session = await kernel.copilotServices.sessionService.getOrCreateSession("user-1", {});
  return {
    ctx: createTestKernelContext({ user: { id: "user-1" } }),
    session,
    workspace: null,
    request: { sessionId: session.id, message: "tool test", clientState: {} },
    turnId: "turn-test",
  };
}
