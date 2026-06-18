import { describe, expect, it } from "vitest";
import { projectAgentRoomEvents, reprojectAgentRoomEvents } from "../src/agent-core/events/AgentRoomEventProjector.js";
import { buildProductBlocks } from "../src/agent-core/runtime/ProductBlockPresenter.js";
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

  it("projects real resume import candidate tool results to experience receiver", () => {
    const productBlocks = buildProductBlocks([{
      status: "success",
      data: {
        job: { id: "pimp-1", type: "import_resume_file", status: "candidates_ready" },
        candidates: [{
          id: "pimpcand-1",
          category: "work",
          title: "Frontend Engineer at Acme",
          organization: "Acme",
          role: "Frontend Engineer",
          content: "Built a React dashboard and improved load time by 35%.",
          status: "pending",
        }],
        formSchemaVersion: 1,
      },
      actionResult: {
        status: "success",
        actionType: "import_resume_file_as_candidates",
      },
    }]);
    const events = projectAgentRoomEvents({ productBlocks });

    expect(events).toHaveLength(1);
    expect(events[0].agentName).toBe("experience_receiver");
    expect(events[0].specialInfo?.kind).toBe("experience_candidate_form");
  });

  it("does not project generate_resume_from_jd pseudo candidates as experience receiver events", () => {
    const productBlocks = buildProductBlocks([{
      status: "success",
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
    const events = projectAgentRoomEvents({ productBlocks });

    expect(events.some((event) => event.agentName === "experience_receiver")).toBe(false);
    expect(events.some((event) => event.specialInfo?.kind === "experience_candidate_form")).toBe(false);
  });

  it("projects jd_analysis_result block as visible special info for JD analyst", () => {
    const block: ProductBlock = {
      type: "jd_analysis_result",
      title: "JD analysis result",
      data: {
        jdTitle: "Frontend Engineer",
        company: "Coolto",
        roleType: "full_time",
        requirements: [{ type: "tool", text: "Vue3 and TypeScript", importance: "must_have" }],
        responsibilities: ["Build product UI"],
        resumeGaps: [],
        matchedExperiences: [],
        nextActions: [{ id: "generate_resume", actionType: "generate_resume", label: "Generate resume" }],
        summary: "Good partial fit.",
      },
    };
    const events = projectAgentRoomEvents({ productBlocks: [block] });
    expect(events).toHaveLength(1);
    expect(events[0].agentName).toBe("strategist");
    expect(events[0].agentRoleLabel).toBe("JD Analyst");
    expect(events[0].eventKind).toBe("special_info");
    expect(events[0].visibility).toBe("visible");
    expect(events[0].specialInfo?.kind).toBe("jd_analysis_result");
    expect(events[0].specialInfo?.data?.jdTitle).toBe("Frontend Engineer");
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

  it("projects compose_career_text success as writing_result special info", () => {
    const events = projectAgentRoomEvents({
      toolResults: [{
        status: "success",
        message: "Draft ready.",
        visibility: "user_summary",
        actionResult: { status: "success", actionType: "compose_career_text" },
        resultKind: "asset_grounded_text_completed",
        data: {
          title: "Self introduction",
          outputType: "self_intro",
          content: "I turn SQL and Power BI work into product insights.",
          alternatives: [{ title: "Short", content: "Short version." }],
          usedExperienceIds: ["pexp-11111111-1111-4111-8111-111111111111"],
          usedEvidenceIds: ["pexp-11111111-1111-4111-8111-111111111111"],
          groundingNotes: ["Used WEEX dashboard evidence."],
          riskNotes: ["No unsupported metrics added."],
          suggestions: ["Ask for an English version."],
          groundingDiagnostics: {
            evidenceRag: { status: "ok", trigger: "experience" },
            guidelineRag: { status: "ok", filteredFactBearingCount: 0 },
            preferenceBank: { status: "ok", appliedCount: 1 },
          },
          guidelineRagApplied: true,
          personalizationApplied: 1,
          appliedPreferenceIds: ["pref-1"],
        },
        nextActionHints: [{
          type: "compose_career_text_variant",
          label: "Generate a shorter version",
          payload: { outputType: "self_intro" },
        }],
      }],
    });

    expect(events).toHaveLength(1);
    expect(events[0].eventKind).toBe("special_info");
    expect(events[0].agentName).toBe("architect");
    expect(events[0].relatedToolName).toBe("compose_career_text");
    expect(events[0].specialInfo?.kind).toBe("writing_result");
    expect(events[0].specialInfo?.title).toBe("Self introduction");
    expect(events[0].specialInfo?.data?.content).toContain("SQL and Power BI");
    expect(events[0].specialInfo?.data?.usedExperienceIds).toEqual(["pexp-11111111-1111-4111-8111-111111111111"]);
    expect(events[0].specialInfo?.data?.usedEvidenceIds).toEqual(["pexp-11111111-1111-4111-8111-111111111111"]);
    expect(events[0].specialInfo?.data?.groundingDiagnostics).toMatchObject({
      evidenceRag: { status: "ok", trigger: "experience" },
    });
    expect(events[0].specialInfo?.data?.styleOnlyFields).toEqual(expect.arrayContaining([
      "groundingDiagnostics.guidelineRag",
      "groundingDiagnostics.preferenceBank",
    ]));
    expect(events[0].specialInfo?.relatedResourceIds?.experienceIds).toEqual(["pexp-11111111-1111-4111-8111-111111111111"]);
    expect(events[0].specialInfo?.actions?.[0]?.type).toBe("compose_career_text_variant");
  });

  it("projects compose_career_text needs_input as writing_result special info", () => {
    const events = projectAgentRoomEvents({
      toolResults: [{
        status: "needs_input",
        message: "Please add an experience first.",
        visibility: "error_user_visible",
        actionResult: {
          status: "needs_input",
          actionType: "compose_career_text",
          reason: "no_assets",
          missingInputs: ["experienceText"],
        },
        resultKind: "asset_grounded_text_needs_input",
        data: {
          title: "Writing input needed",
          outputType: "self_intro",
          content: "",
          alternatives: [],
          usedExperienceIds: [],
          usedEvidenceIds: [],
          groundingNotes: [],
          riskNotes: ["No saved experiences were available."],
          suggestions: ["Save a real experience first."],
        },
      }],
    });

    expect(events).toHaveLength(1);
    expect(events[0].eventKind).toBe("special_info");
    expect(events[0].visibility).toBe("visible");
    expect(events[0].specialInfo?.kind).toBe("writing_result");
    expect(events[0].specialInfo?.data?.resultKind).toBe("asset_grounded_text_needs_input");
    expect(events[0].specialInfo?.data?.riskNotes).toEqual(["No saved experiences were available."]);
    expect(events[0].specialInfo?.data?.suggestions).toEqual(["Save a real experience first."]);
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
