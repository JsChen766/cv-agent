import { describe, expect, it } from "vitest";
import { AssistantMessageProjector } from "../src/agent-core/runtime/AssistantMessageProjector.js";
import {
  buildProductBlocks,
  isExperienceImportCandidateLike,
} from "../src/agent-core/runtime/ProductBlockPresenter.js";
import type { ToolResult } from "../src/agent-core/tools/ToolResult.js";
import type { CopilotWorkspace, ProductBlock } from "../src/copilot/types.js";

const importCandidate = {
  id: "pimpcand-1",
  jobId: "pimp-1",
  category: "project" as const,
  title: "Analytics dashboard project",
  organization: "Acme",
  role: "Frontend Engineer",
  startDate: "2024-01",
  endDate: "2024-06",
  content: "Built a TypeScript analytics dashboard and reduced report preparation time by 40%.",
  status: "pending" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const importJob = {
  id: "pimp-1",
  type: "import_resume_file",
  status: "candidates_ready",
};

describe("ProductBlockPresenter experience candidate form guards", () => {
  it("does not build experience_candidate_form from generate_resume_from_jd tool data", () => {
    const blocks = buildProductBlocks([{
      status: "success",
      message: "Resume generation completed.",
      data: {
        job: { id: "job-1" },
        candidates: [{
          id: "fake-1",
          category: "project",
          title: "我已准备好基于这份 JD 生成简历版本，请确认后开始。",
          content: "正在调用工具：generate_resume_from_jd",
        }],
        formSchemaVersion: 1,
      },
      actionResult: {
        status: "success",
        actionType: "generate_resume_from_jd",
      },
    }]);

    expect(blocks.some((block) => block.type === "experience_candidate_form")).toBe(false);
  });

  it("filters pseudo candidates and suppresses an empty experience_candidate_form", () => {
    const blocks = buildProductBlocks([{
      status: "success",
      data: {
        job: importJob,
        candidates: [{
          id: "fake-1",
          category: "project",
          title: "我已准备好基于这份 JD 生成简历版本，请确认后开始。",
          content: "正在调用工具：generate_resume_from_jd\n处理完成。",
        }],
        formSchemaVersion: 1,
      },
      actionResult: {
        status: "success",
        actionType: "import_resume_file_as_candidates",
      },
    }]);

    expect(blocks).toEqual([]);
    expect(isExperienceImportCandidateLike({
      id: "fake-1",
      category: "project",
      title: "Tool completed",
      content: "pending action confirmation",
    })).toBe(false);
  });

  it("builds experience_candidate_form for real resume import candidates", () => {
    const blocks = buildProductBlocks([{
      status: "success",
      data: {
        job: importJob,
        candidates: [importCandidate],
        formSchemaVersion: 1,
        saveMode: "accept_candidate",
      },
      actionResult: {
        status: "success",
        actionType: "import_resume_file_as_candidates",
      },
    }]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "experience_candidate_form",
      data: {
        formSchemaVersion: 1,
        candidates: [expect.objectContaining({
          id: importCandidate.id,
          category: "project",
          title: importCandidate.title,
        })],
      },
    });
  });

  it("allows explicit import source metadata even without an import actionResult", () => {
    const blocks = buildProductBlocks([{
      status: "success",
      data: {
        source: "resume_upload",
        job: { id: "job-1" },
        candidates: [importCandidate],
        formSchemaVersion: 1,
      },
    }]);

    expect(blocks[0]?.type).toBe("experience_candidate_form");
  });

  it("does not turn prior workspace importCandidates into this turn's productBlocks", () => {
    const currentTurnResults: ToolResult[] = [{
      status: "success",
      data: {
        generationId: "gen-1",
        variants: [],
      },
      workspacePatch: {
        activePanel: "variants",
        status: "ready",
      },
      actionResult: {
        status: "success",
        actionType: "generate_resume_from_jd",
      },
    }];
    const productBlocks = buildProductBlocks(currentTurnResults);
    const projector = new AssistantMessageProjector();
    const metadata = projector.buildMetadata({
      toolResults: currentTurnResults,
      workspace: workspaceWithPreviousImportCandidate,
      workspacePatch: currentTurnResults[0].workspacePatch ?? {},
      pendingActions: [],
      productBlocks,
    });

    const snapshotBlocks = metadata.displaySnapshot?.productBlocks as ProductBlock[] | undefined;
    expect(productBlocks.some((block) => block.type === "experience_candidate_form")).toBe(false);
    expect(snapshotBlocks?.some((block) => block.type === "experience_candidate_form") ?? false).toBe(false);
  });
});

const workspaceWithPreviousImportCandidate: CopilotWorkspace = {
  id: "ws-1",
  sessionId: "session-1",
  variants: [],
  importCandidates: [importCandidate],
  activePanel: "import_candidates",
  status: "awaiting_user_decision",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
