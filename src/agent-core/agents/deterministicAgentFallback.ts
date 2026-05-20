import type { AgentDecision, AgentName, PlanStep } from "../validation/AgentOutputSchemas.js";

const PRODUCT_INTRO =
  "我是你的求职经历 Copilot，可以帮你整理经历、分析 JD、生成和修改简历。有什么我可以帮你的？";

function step(
  id: string,
  agentName: AgentName,
  toolName: string,
  args: Record<string, unknown>,
  summary: string,
): PlanStep {
  return { id, agentName, toolName, arguments: args, summary };
}

function decision(
  agentName: AgentName,
  responseType: AgentDecision["responseType"],
  assistantMessage: string,
  plan: PlanStep[] = [],
  missingInputs: string[] = [],
  confidence = 0.5,
  routeTo?: AgentName,
): AgentDecision {
  const result: AgentDecision = {
    agentName,
    responseType,
    assistantMessage,
    plan,
    missingInputs,
    confidence,
  };
  if (routeTo) result.routeTo = routeTo;
  return result;
}

function lower(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

export function fallbackAgentDecision(
  agentName: AgentName,
  input: { userMessage?: string; clientState?: Record<string, unknown> },
): AgentDecision {
  const msg = lower(input.userMessage);

  switch (agentName) {
    case "frontdesk":
      return frontDeskFallback(msg);
    case "experience_receiver":
      return experienceReceiverFallback(msg, input.userMessage ?? "");
    case "strategist":
      return strategistFallback(msg);
    case "architect":
      return architectFallback(msg, input.clientState ?? {});
    case "critic":
      return criticFallback(msg);
    default:
      return decision(agentName, "ask_clarification", "请说明你想做什么。", [], ["intent"], 0.3);
  }
}

function frontDeskFallback(msg: string): AgentDecision {
  // Save experience intent
  if (
    containsAny(msg, ["保存", "save", "这是我的经历", "存到经历库", "保存这段经历", "保存下", "存一下"])
  ) {
    return decision("frontdesk", "route", "我来帮你保存这段经历。", [], [], 0.85, "experience_receiver");
  }

  // View / query experience library
  if (
    containsAny(msg, [
      "经历库", "我的经历", "查看经历", "经历是否为空",
      "experience", "library", "list", "还是空", "有没有经历",
    ])
  ) {
    return decision("frontdesk", "route", "我来查看你的经历库。", [], [], 0.85, "experience_receiver");
  }

  // JD / job description
  if (containsAny(msg, ["jd", "岗位", "职位描述", "job", "position", "招聘"])) {
    return decision("frontdesk", "route", "我来分析这个岗位描述。", [], [], 0.85, "strategist");
  }

  // Resume generation / modification / export
  if (
    containsAny(msg, ["简历", "resume", "生成", "导出", "export", "修改简历", "cv"])
  ) {
    return decision("frontdesk", "route", "我来准备简历操作。", [], [], 0.85, "architect");
  }

  // Evidence / claims
  if (containsAny(msg, ["证据", "夸大", "真实", "evidence", "claim", "核实", "检查"])) {
    return decision("frontdesk", "route", "我来检查相关证据。", [], [], 0.85, "critic");
  }

  // Delete experience — route to experience_receiver but will need clarification
  if (containsAny(msg, ["删除", "delete", "remove"])) {
    return decision("frontdesk", "route", "我来处理删除请求。", [], [], 0.7, "experience_receiver");
  }

  // Default: friendly product intro
  return decision("frontdesk", "final", PRODUCT_INTRO, [], [], 0.7);
}

function experienceReceiverFallback(msg: string, rawMessage: string): AgentDecision {
  // Save experience with substantial text
  if (
    containsAny(msg, ["保存", "save", "这是我的经历", "存到经历库", "保存下", "存一下", "保存这段经历"])
  ) {
    if (rawMessage.length > 30) {
      return decision(
        "experience_receiver",
        "plan",
        "我先整理一下这段经历，然后需要你确认保存。",
        [
          step(
            "step-1",
            "experience_receiver",
            "prepare_save_experience_from_text",
            { text: rawMessage },
            "Prepare experience from user-provided text.",
          ),
        ],
        [],
        0.85,
      );
    }
    return decision(
      "experience_receiver",
      "ask_clarification",
      "请提供更详细的经历描述，我好帮你保存。",
      [],
      ["experienceText"],
      0.7,
    );
  }

  // List / check if empty
  if (
    containsAny(msg, [
      "list", "查看", "是否为空", "还是空", "有没有", "所有经历",
      "经历库", "我的经历", "experience", "library", "列出",
    ])
  ) {
    return decision(
      "experience_receiver",
      "plan",
      "我来查看你的经历库。",
      [
        step(
          "step-1",
          "experience_receiver",
          "list_experiences",
          {},
          "List all experiences in the library.",
        ),
      ],
      [],
      0.9,
    );
  }

  // Search
  if (containsAny(msg, ["搜索", "search", "查找", "找"])) {
    return decision(
      "experience_receiver",
      "plan",
      "我来搜索相关的经历。",
      [
        step(
          "step-1",
          "experience_receiver",
          "search_experiences",
          { query: rawMessage },
          "Search experiences by keyword.",
        ),
      ],
      [],
      0.8,
    );
  }

  // Delete or update — ask clarification, don't execute writes
  if (containsAny(msg, ["删除", "delete", "修改", "update", "edit", "改"])) {
    return decision(
      "experience_receiver",
      "ask_clarification",
      "请告诉我具体要删除或修改哪条经历，以及你想怎么改。",
      [],
      ["targetExperience", "action"],
      0.6,
    );
  }

  // Default: list experiences
  return decision(
    "experience_receiver",
    "plan",
    "我来查看你的经历库。",
    [
      step(
        "step-1",
        "experience_receiver",
        "list_experiences",
        {},
        "List all experiences.",
      ),
    ],
    [],
    0.7,
  );
}

function strategistFallback(msg: string): AgentDecision {
  if (containsAny(msg, ["jd", "岗位", "职位描述", "job", "position", "招聘"])) {
    return decision(
      "strategist",
      "plan",
      "我来分析 JD 并匹配你的经历。",
      [
        step("step-1", "strategist", "list_experiences", {}, "List all experiences for JD matching."),
        step("step-2", "strategist", "get_jd", {}, "Retrieve the current JD for analysis."),
      ],
      [],
      0.8,
    );
  }
  return decision(
    "strategist",
    "plan",
    "我来分析你的经历匹配情况。",
    [
      step("step-1", "strategist", "list_experiences", {}, "List experiences for strategy analysis."),
    ],
    [],
    0.7,
  );
}

function architectFallback(msg: string, clientState: Record<string, unknown>): AgentDecision {
  if (containsAny(msg, ["导出", "export"])) {
    const resumeId = clientState.activeResumeId as string | undefined;
    return decision(
      "architect",
      "plan",
      "我来准备导出你的简历。",
      [
        step(
          "step-1",
          "architect",
          "prepare_export_resume",
          { resumeId: resumeId ?? "current" },
          "Prepare resume for export.",
        ),
      ],
      [],
      0.85,
    );
  }

  if (containsAny(msg, ["修改", "revise", "edit", "改", "优化"])) {
    const resumeItemId = clientState.activeResumeItemId as string | undefined;
    if (resumeItemId) {
      return decision(
        "architect",
        "plan",
        "我来修改这个简历条目。",
        [
          step(
            "step-1",
            "architect",
            "revise_resume_item",
            { resumeItemId, instruction: msg || "Revise this resume item." },
            "Revise resume item.",
          ),
        ],
        [],
        0.8,
      );
    }
    return decision(
      "architect",
      "ask_clarification",
      "请选择你想修改的简历条目，然后告诉我怎么改。",
      [],
      ["resumeItemId", "instruction"],
      0.6,
    );
  }

  if (containsAny(msg, ["生成", "generate", "创建", "create", "简历", "resume"])) {
    return decision(
      "architect",
      "plan",
      "我来基于 JD 生成简历，需要你确认。",
      [
        step(
          "step-1",
          "architect",
          "generate_resume_from_jd",
          {},
          "Generate resume from JD after confirmation.",
        ),
      ],
      [],
      0.8,
    );
  }

  return decision(
    "architect",
    "plan",
    "我来查看简历列表。",
    [
      step("step-1", "architect", "list_resumes", {}, "List all resumes."),
    ],
    [],
    0.7,
  );
}

function criticFallback(msg: string): AgentDecision {
  if (containsAny(msg, ["证据", "evidence", "show"])) {
    return decision(
      "critic",
      "plan",
      "我来展示相关证据。",
      [
        step("step-1", "critic", "show_evidence", { id: "current" }, "Show evidence for the current claim."),
      ],
      [],
      0.85,
    );
  }

  if (containsAny(msg, ["夸大", "真实", "核实", "check", "claim", "unsupported"])) {
    return decision(
      "critic",
      "plan",
      "我来检查经历中的潜在风险。",
      [
        step("step-1", "critic", "check_unsupported_claims", {}, "Check all experiences for unsupported claims."),
      ],
      [],
      0.85,
    );
  }

  return decision(
    "critic",
    "plan",
    "我来检查声明的可靠性。",
    [
      step("step-1", "critic", "check_unsupported_claims", {}, "Check unsupported claims."),
    ],
    [],
    0.7,
  );
}

function containsAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}
