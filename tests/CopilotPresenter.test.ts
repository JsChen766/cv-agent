import { describe, expect, it } from "vitest";
import { CopilotPresenter } from "../src/copilot/CopilotPresenter.js";

describe("CopilotPresenter", () => {
  it("merges tool actionResult into raw actionResults and primaryActionResult", () => {
    const presenter = new CopilotPresenter();
    const response = presenter.present({
      sessionId: "session-1",
      turnId: "turn-1",
      decision: {
        mode: "call_tool",
        assistantMessage: "",
        toolCalls: [{ toolName: "export_resume", arguments: {} }],
        confidence: 1,
      },
      workspace: {
        id: "ws-session-1",
        sessionId: "session-1",
        variants: [],
        status: "ready",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
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
    expect(response.raw.primaryActionResult).toMatchObject({
      actionType: "export_resume",
      status: "success",
      exportRecord: { id: "export-1", jobId: "job-1" },
    });
  });
});
