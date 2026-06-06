import { describe, expect, it } from "vitest";
import { projectAgentRoomEvents, reprojectAgentRoomEvents } from "../src/agent-core/events/AgentRoomEventProjector.js";
import type { ProductBlock, CopilotMessageMetadata } from "../src/copilot/types.js";
import type { PendingAction } from "../src/agent-core/confirmation/PendingAction.js";

describe("AgentRoomEventProjector", () => {
  it("projects experience_match_results block as special_info event", () => {
    const block: ProductBlock = {
      type: "experience_match_results",
      title: "JD Match Results",
      data: { totalCount: 5, highMatches: 2 },
    };
    const events = projectAgentRoomEvents({ productBlocks: [block] });
    expect(events).toHaveLength(1);
    expect(events[0].eventKind).toBe("special_info");
    expect(events[0].agentName).toBe("strategist");
    expect(events[0].agentRoleLabel).toBe("JD Analyst");
    expect(events[0].specialInfo?.kind).toBe("match_matrix");
  });

  it("projects experience_list block as asset_capsule", () => {
    const block: ProductBlock = {
      type: "experience_list",
      data: { count: 3, items: [] },
    };
    const events = projectAgentRoomEvents({ productBlocks: [block] });
    expect(events).toHaveLength(1);
    expect(events[0].agentName).toBe("experience_receiver");
    expect(events[0].specialInfo?.kind).toBe("asset_capsule");
  });

  it("projects experience_candidate_form block as editable special info for experience receiver", () => {
    const block: ProductBlock = {
      type: "experience_candidate_form",
      title: "待确认的经历候选",
      data: {
        job: { id: "pimp-1", status: "candidates_ready" },
        candidates: [{
          id: "pimpcand-1",
          category: "education",
          title: "Sun Yat-sen University",
          organization: "Sun Yat-sen University",
          role: "Computer Science",
          startDate: "2022-09",
          endDate: "2026-06",
          content: "Bachelor in Computer Science.",
          structured: { school: "Sun Yat-sen University" },
          status: "pending",
        }],
        formSchemaVersion: 1,
        saveMode: "accept_candidate",
      },
    };
    const events = projectAgentRoomEvents({ productBlocks: [block] });
    expect(events).toHaveLength(1);
    expect(events[0].agentName).toBe("experience_receiver");
    expect(events[0].eventKind).toBe("special_info");
    expect(events[0].visibility).toBe("visible");
    expect(events[0].specialInfo?.kind).toBe("experience_candidate_form");
    expect((events[0].specialInfo?.data?.candidates as Array<Record<string, unknown>>)[0].category).toBe("education");
  });

  it("projects action_result block as decision_panel", () => {
    const block: ProductBlock = {
      type: "action_result",
      data: { actionType: "accept_generation_variant" },
    };
    const events = projectAgentRoomEvents({ productBlocks: [block] });
    expect(events).toHaveLength(1);
    expect(events[0].agentName).toBe("system");
    expect(events[0].specialInfo?.kind).toBe("decision_panel");
  });

  it("returns empty array for unknown block type gracefully", () => {
    const block: ProductBlock = {
      type: "unknown_future_block" as ProductBlock["type"],
      data: {},
    };
    const events = projectAgentRoomEvents({ productBlocks: [block] });
    // Unknown blocks are silently skipped — no crash
    expect(events).toHaveLength(0);
  });

  it("projects tool results with failed status as error events", () => {
    const events = projectAgentRoomEvents({
      toolResults: [{
        status: "failed",
        message: "Something went wrong.",
        visibility: "error_user_visible",
        actionResult: { actionType: "bad_tool" },
      }],
    });
    expect(events).toHaveLength(1);
    expect(events[0].eventKind).toBe("error");
    expect(events[0].visibility).toBe("error_visible");
  });

  it("skips internal-visibility tool results", () => {
    const events = projectAgentRoomEvents({
      toolResults: [{
        status: "success",
        message: "Internal operation.",
        visibility: "internal",
      }],
    });
    expect(events).toHaveLength(0);
  });

  it("projects pending experience action with structured draft as decision_panel", () => {
    const pendingAction: PendingAction = {
      id: "pa-1",
      userId: "user-1",
      sessionId: "session-1",
      turnId: "turn-1",
      toolName: "save_experience_from_text",
      toolArguments: { text: "Intern at Acme" },
      status: "pending",
      title: "Save experience",
      summary: "Please confirm saving this experience.",
      riskLevel: "medium",
      affectedResources: [],
      preview: {
        after: {
          experienceDraft: {
            category: "internship",
            title: "Acme AI Intern",
            organization: "Acme",
            role: "AI Intern",
            startDate: "2025-02",
            endDate: "2025-06",
          },
        },
      },
      createdAt: "2026-01-01T00:00:00Z",
      expiresAt: "2026-01-02T00:00:00Z",
    };
    const events = projectAgentRoomEvents({ pendingActions: [pendingAction] });
    expect(events).toHaveLength(1);
    expect(events[0].agentName).toBe("experience_receiver");
    expect(events[0].eventKind).toBe("pending_action");
    expect(events[0].specialInfo?.kind).toBe("decision_panel");
    expect((events[0].specialInfo?.data?.pendingAction as Record<string, unknown>).id).toBe("pa-1");
    const action = events[0].specialInfo?.data?.pendingAction as { preview?: { after?: { experienceDraft?: Record<string, unknown> } } };
    expect(action.preview?.after?.experienceDraft?.category).toBe("internship");
  });

  it("projects workspace patch activePanel as asset_capsule system event", () => {
    const events = projectAgentRoomEvents({
      workspacePatch: { activePanel: "variants", experiences: [{ id: "exp-1" }] },
    });
    expect(events).toHaveLength(1);
    expect(events[0].agentName).toBe("system");
    expect(events[0].specialInfo?.kind).toBe("asset_capsule");
  });

  it("does not modify any existing ProductBlock data", () => {
    const block: ProductBlock = {
      type: "experience_card",
      title: "My Card",
      data: { id: "exp-1", title: "Test" },
    };
    const original = JSON.stringify(block);
    projectAgentRoomEvents({ productBlocks: [block] });
    // Block data is never mutated
    expect(JSON.stringify(block)).toBe(original);
  });
});

describe("reprojectAgentRoomEvents — history fallback", () => {
  it("returns empty for undefined metadata", () => {
    const events = reprojectAgentRoomEvents(undefined);
    expect(events).toEqual([]);
  });

  it("returns empty for metadata with no useful fields", () => {
    const events = reprojectAgentRoomEvents({});
    expect(events).toEqual([]);
  });

  it("uses persisted agentRoomEvents when available", () => {
    const persisted = [{
      id: "evt-stored-1",
      agentName: "strategist" as const,
      agentRoleLabel: "JD Analyst",
      eventKind: "special_info" as const,
      visibility: "visible" as const,
      content: "Pre-stored event",
      createdAt: "2026-01-01T00:00:00Z",
    }];
    const metadata: CopilotMessageMetadata = { agentRoomEvents: persisted };
    const events = reprojectAgentRoomEvents(metadata);
    expect(events).toEqual(persisted);
  });

  it("fallback-projects from displaySnapshot when no agentRoomEvents", () => {
    const block: ProductBlock = {
      type: "experience_match_results",
      title: "Match Results",
      data: { totalCount: 3 },
    };
    const metadata: CopilotMessageMetadata = {
      displaySnapshot: { productBlocks: [block] },
    };
    const events = reprojectAgentRoomEvents(metadata, "msg-1");
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].agentName).toBe("strategist");
    expect(events[0].specialInfo?.kind).toBe("match_matrix");
  });

  it("uses deterministic IDs with messageId for stable history replay", () => {
    const block: ProductBlock = {
      type: "experience_card",
      data: { id: "exp-1" },
    };
    const metadata: CopilotMessageMetadata = {
      displaySnapshot: { productBlocks: [block] },
    };
    const a = reprojectAgentRoomEvents(metadata, "msg-1");
    const b = reprojectAgentRoomEvents(metadata, "msg-1");
    expect(a.length).toBeGreaterThan(0);
    expect(a[0].id).toBe(b[0].id); // stable
    expect(a[0].id).toContain("evt-history-msg-1");
  });

  it("different messageIds produce different event IDs", () => {
    const metadata: CopilotMessageMetadata = {
      displaySnapshot: { productBlocks: [{ type: "experience_card", data: {} }] },
    };
    const a = reprojectAgentRoomEvents(metadata, "msg-a");
    const b = reprojectAgentRoomEvents(metadata, "msg-b");
    expect(a[0].id).toContain("msg-a");
    expect(b[0].id).toContain("msg-b");
    expect(a[0].id).not.toBe(b[0].id);
  });
});
