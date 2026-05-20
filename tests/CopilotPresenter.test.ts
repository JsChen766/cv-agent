import { describe, expect, it } from "vitest";
import type { AgentToolResult } from "../src/agents/tools/AgentToolRegistry.js";
import { CopilotPresenter } from "../src/copilot/CopilotPresenter.js";
import type { CopilotWorkspace } from "../src/copilot/types.js";

describe("CopilotPresenter", () => {
  it("merges tool actionResult into raw actionResults and primaryActionResult while preserving rawIds", () => {
    const response = new CopilotPresenter().present({
      sessionId: "session-1",
      turnId: "turn-1",
      decision: {
        mode: "call_tool",
        assistantMessage: "",
        toolCalls: [{ toolName: "export_resume", arguments: {} }],
        confidence: 1,
      },
      workspace: workspace(),
      toolResults: [
        {
          status: "success",
          assistantMessage: "Export created.",
          rawIds: {
            artifactIds: ["artifact-1"],
            evidenceChainIds: ["chain-1"],
            critiqueItemIds: ["critique-1"],
            decisionIds: ["export-1", "job-1"],
          },
          actionResult: {
            actionType: "export_resume",
            status: "success",
            exportRecord: {
              id: "export-1",
              resumeId: "resume-1",
              format: "html",
              status: "pending",
              jobId: "job-1",
            },
          },
        },
      ],
    });

    expect(response.raw.artifactIds).toEqual(["artifact-1"]);
    expect(response.raw.evidenceChainIds).toEqual(["chain-1"]);
    expect(response.raw.critiqueItemIds).toEqual(["critique-1"]);
    expect(response.raw.decisionIds).toEqual(["export-1", "job-1"]);
    expect(response.raw.actionResults).toHaveLength(1);
    expect(response.raw.primaryActionResult).toEqual(response.raw.actionResults?.[0]);
  });

  it("keeps exportRecord on primaryActionResult for export_resume results", () => {
    const response = new CopilotPresenter().present(baseInput({
      status: "success",
      actionResult: {
        actionType: "export_resume",
        status: "success",
        exportRecord: {
          id: "export-1",
          resumeId: "resume-1",
          format: "html",
          status: "pending",
          jobId: "job-1",
        },
      },
    }));

    expect(response.raw.primaryActionResult?.exportRecord).toMatchObject({
      id: "export-1",
      jobId: "job-1",
    });
  });

  it("keeps revisionSuggestion on primaryActionResult for rewrite results", () => {
    const response = new CopilotPresenter().present(baseInput({
      status: "success",
      actionResult: {
        actionType: "rewrite_experience",
        status: "success",
        revisionSuggestion: {
          kind: "experience",
          sourceId: "exp-1",
          rewrittenText: "Improved experience text.",
          usedModel: true,
        },
      },
    }));

    expect(response.raw.primaryActionResult?.revisionSuggestion).toMatchObject({
      kind: "experience",
      sourceId: "exp-1",
      rewrittenText: "Improved experience text.",
    });
  });
});

function baseInput(result: AgentToolResult): Parameters<CopilotPresenter["present"]>[0] {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    decision: {
      mode: "call_tool",
      assistantMessage: "",
      toolCalls: [{ toolName: "rewrite_experience", arguments: {} }],
      confidence: 1,
    },
    workspace: workspace(),
    toolResults: [result],
  };
}

function workspace(): CopilotWorkspace {
  return {
    id: "ws-session-1",
    sessionId: "session-1",
    variants: [],
    status: "ready",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
