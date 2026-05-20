import { describe, expect, it, vi } from "vitest";
import type { ApiKernel } from "../src/api/types.js";
import { AgentToolRegistry } from "../src/agents/tools/AgentToolRegistry.js";
import type { AgentToolExecutionContext } from "../src/agents/tools/AgentToolTypes.js";
import type { CopilotSession } from "../src/copilot/types.js";
import type { ResumeExport } from "../src/exports/types.js";
import { createTestKernelContext } from "../src/kernel/context.js";
import type { ProductExperience, ProductExperienceRevision } from "../src/product/types.js";

describe("product action tools", () => {
  it("export_resume returns needs_input when resumeId is missing", async () => {
    const result = await registryFor(mockKernel()).execute("export_resume", {}, toolContext());

    expect(result.status).toBe("needs_input");
    expect(result.actionResult).toMatchObject({
      actionType: "export_resume",
      status: "needs_input",
      missingInputs: ["resumeId"],
    });
  });

  it("export_resume returns structured export result on success", async () => {
    const createExport = vi.fn().mockResolvedValue({
      exportRecord: exportRecord({ id: "export-1", resumeId: "resume-1", jobId: "job-1" }),
      job: { id: "job-1" },
    });
    const result = await registryFor(mockKernel({ exportService: { createExport } }))
      .execute("export_resume", { resumeId: "resume-1", format: "html" }, toolContext());

    expect(createExport).toHaveBeenCalledWith("user-1", {
      resumeId: "resume-1",
      format: "html",
      templateId: undefined,
    });
    expect(result.status).toBe("success");
    expect(result.actionResult).toMatchObject({
      actionType: "export_resume",
      status: "success",
      exportRecord: expect.objectContaining({ id: "export-1", resumeId: "resume-1", jobId: "job-1" }),
    });
    expect(result.workspacePatch).toMatchObject({
      activeExportId: "export-1",
      exportRecords: [expect.objectContaining({ id: "export-1" })],
    });
    expect(result.timelineItems?.[0]?.type).toBe("export_created");
    expect(result.raw).toMatchObject({ exportId: "export-1", jobId: "job-1" });
  });

  it("optimize_resume_item returns needs_input when selectedText and resumeItemId are missing", async () => {
    const result = await registryFor(mockKernel()).execute("optimize_resume_item", {}, toolContext());

    expect(result.status).toBe("needs_input");
    expect(result.actionResult).toMatchObject({
      actionType: "optimize_resume_item",
      status: "needs_input",
      missingInputs: ["selectedText", "resumeItemId"],
    });
  });

  it("optimize_resume_item returns model-backed revisionSuggestion for selectedText", async () => {
    const result = await registryFor(mockKernel({
      frontDeskModelClient: {
        chat: vi.fn().mockResolvedValue({ content: "Improved resume bullet." }),
      },
    })).execute("optimize_resume_item", {
      resumeId: "resume-1",
      resumeItemId: "item-1",
      selectedText: "Built React systems for internal users.",
      instruction: "make_more_quantified",
    }, toolContext());

    expect(result.status).toBe("success");
    expect(result.actionResult?.revisionSuggestion).toMatchObject({
      kind: "resume_item",
      sourceId: "item-1",
      rewrittenText: "Improved resume bullet.",
      usedModel: true,
    });
  });

  it("optimize_resume_item falls back without exposing provider errors when model client fails", async () => {
    const result = await registryFor(mockKernel({
      frontDeskModelClient: {
        chat: vi.fn().mockRejectedValue(new Error("provider raw failure")),
      },
    })).execute("optimize_resume_item", {
      resumeItemId: "item-1",
      selectedText: "Built React systems for internal users.",
      instruction: "make_more_conservative",
    }, toolContext());

    expect(result.status).toBe("success");
    expect(result.actionResult?.revisionSuggestion).toMatchObject({
      kind: "resume_item",
      sourceId: "item-1",
      usedModel: false,
    });
    expect(result.actionResult?.revisionSuggestion?.rewrittenText).toContain("Suggestion:");
    expect(JSON.stringify(result)).not.toContain("provider raw failure");
  });

  it("rewrite_experience returns needs_input when selectedText is missing and no experience can be read", async () => {
    const result = await registryFor(mockKernel()).execute("rewrite_experience", {}, toolContext());

    expect(result.status).toBe("needs_input");
    expect(result.actionResult).toMatchObject({
      actionType: "rewrite_experience",
      status: "needs_input",
      missingInputs: ["selectedText", "experienceId"],
    });
  });

  it("rewrite_experience returns model-backed experience revisionSuggestion", async () => {
    const result = await registryFor(mockKernel({
      frontDeskModelClient: {
        chat: vi.fn().mockResolvedValue({ content: "Improved experience text." }),
      },
    })).execute("rewrite_experience", {
      experienceId: "exp-1",
      selectedText: "Led frontend migration from legacy stack.",
    }, toolContext());

    expect(result.status).toBe("success");
    expect(result.actionResult?.revisionSuggestion).toMatchObject({
      kind: "experience",
      sourceId: "exp-1",
      rewrittenText: "Improved experience text.",
      usedModel: true,
    });
  });

  it("rewrite_experience can read current or latest revision when only experienceId is provided", async () => {
    const experience = productExperience({ id: "exp-1", currentRevisionId: undefined });
    const revisions = [
      experienceRevision({ id: "rev-old", content: "Older experience content.", createdAt: "2026-01-01T00:00:00.000Z" }),
      experienceRevision({ id: "rev-new", content: "Newest experience content.", createdAt: "2026-01-03T00:00:00.000Z" }),
    ];
    const result = await registryFor(mockKernel({
      productServices: {
        experienceService: {
          getExperience: vi.fn().mockResolvedValue(experience),
          listRevisions: vi.fn().mockResolvedValue(revisions),
        },
      },
      frontDeskModelClient: {
        chat: vi.fn().mockResolvedValue({ content: "Newest content rewritten." }),
      },
    })).execute("rewrite_experience", { experienceId: "exp-1" }, toolContext());

    expect(result.status).toBe("success");
    expect(result.actionResult?.revisionSuggestion).toMatchObject({
      kind: "experience",
      sourceId: "exp-1",
      sourceTextPreview: "Newest experience content.",
      rewrittenText: "Newest content rewritten.",
    });
  });
});

function registryFor(kernel: ApiKernel): AgentToolRegistry {
  return new AgentToolRegistry(kernel);
}

function mockKernel(overrides: {
  exportService?: Partial<ApiKernel["exportService"]>;
  productServices?: {
    resumeService?: Partial<ApiKernel["productServices"]["resumeService"]>;
    experienceService?: Partial<ApiKernel["productServices"]["experienceService"]>;
  };
  frontDeskModelClient?: Partial<NonNullable<ApiKernel["frontDeskModelClient"]>>;
} = {}): ApiKernel {
  return {
    productServices: {
      resumeService: {
        getResume: vi.fn().mockResolvedValue(null),
        ...overrides.productServices?.resumeService,
      },
      experienceService: {
        getExperience: vi.fn().mockResolvedValue(null),
        listRevisions: vi.fn().mockResolvedValue([]),
        ...overrides.productServices?.experienceService,
      },
    },
    exportService: {
      createExport: vi.fn().mockResolvedValue({
        exportRecord: exportRecord(),
        job: { id: "job-1" },
      }),
      ...overrides.exportService,
    },
    frontDeskModelClient: overrides.frontDeskModelClient ?? {
      chat: vi.fn().mockResolvedValue({ content: "Model rewrite." }),
    },
  } as unknown as ApiKernel;
}

function toolContext(): AgentToolExecutionContext {
  return {
    ctx: createTestKernelContext({ user: { id: "user-1" } }),
    session: session(),
    workspace: null,
    request: { sessionId: "session-1", message: "tool test", clientState: {} },
    turnId: "turn-test",
  };
}

function session(): CopilotSession {
  return {
    id: "session-1",
    userId: "user-1",
    status: "active",
    resumeIngested: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function exportRecord(overrides: Partial<ResumeExport> = {}): ResumeExport {
  return {
    id: "export-1",
    userId: "user-1",
    resumeId: "resume-1",
    jobId: "job-1",
    format: "html",
    templateId: "default",
    status: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function productExperience(overrides: Partial<ProductExperience> = {}): ProductExperience {
  return {
    id: "exp-1",
    userId: "user-1",
    category: "project",
    title: "Search rewrite",
    organization: "Acme",
    role: "Frontend Engineer",
    tags: [],
    status: "active",
    currentRevisionId: "rev-current",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function experienceRevision(overrides: Partial<ProductExperienceRevision> = {}): ProductExperienceRevision {
  return {
    id: "rev-1",
    experienceId: "exp-1",
    userId: "user-1",
    content: "Revision content.",
    source: "manual",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
