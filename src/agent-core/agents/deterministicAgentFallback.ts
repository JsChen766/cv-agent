import type { AgentDecision, AgentName, PlanStep } from "../validation/AgentOutputSchemas.js";

/*
 * Deterministic fallback — invoked ONLY when the modelClient is unavailable or
 * the LLM output cannot be parsed / repaired.
 *
 * This is NOT a router. It uses minimal, broad keyword checks to produce a
 * safe, read-only-biased decision. Every agent has at most 2–3 paths.
 */

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

function dec(
  agentName: AgentName,
  responseType: AgentDecision["responseType"],
  assistantMessage: string,
  opts: {
    plan?: PlanStep[];
    missingInputs?: string[];
    confidence?: number;
    routeTo?: AgentName;
  } = {},
): AgentDecision {
  const d: AgentDecision = {
    agentName,
    responseType,
    assistantMessage,
    plan: opts.plan ?? [],
    missingInputs: opts.missingInputs ?? [],
    confidence: opts.confidence ?? 0.5,
  };
  if (opts.routeTo) d.routeTo = opts.routeTo;
  return d;
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
      return experienceReceiverFallback(input.userMessage ?? "");
    case "strategist":
      return strategistFallback();
    case "architect":
      return architectFallback(msg, input.clientState ?? {});
    case "critic":
      return criticFallback();
    default:
      return dec(agentName, "ask_clarification", "请说明你想做什么。", { missingInputs: ["intent"] });
  }
}

// ── FrontDesk ────────────────────────────────────────────
// Only 4 paths: experience, resume, JD, or friendly intro.

function frontDeskFallback(msg: string): AgentDecision {
  if (containsAny(msg, [
    "experience",
    "经历",
    "university",
    "college",
    "bachelor",
    "master",
    "gpa",
    "intern",
    "internship",
    "project",
    "award",
    "skill",
    "company",
  ])) {
    return dec("frontdesk", "route", "我来转交给经历编目员整理这段经历。", { routeTo: "experience_receiver", confidence: 0.8 });
  }
  if (containsAny(msg, ["resume", "简历", "export", "导出", "cv"])) {
    return dec("frontdesk", "route", "我来准备简历操作。", { routeTo: "architect", confidence: 0.8 });
  }
  // JD + experience matching intent → route to experience_receiver
  if (containsAny(msg, ["jd", "岗位", "job"]) && containsAny(msg, ["match", "匹配", "符合", "适合", "哪些经历", "经历库"])) {
    return dec("frontdesk", "route", "我来对比你的经历库和这份 JD。", { routeTo: "experience_receiver", confidence: 0.85 });
  }
  if (containsAny(msg, ["jd", "岗位", "job"])) {
    return dec("frontdesk", "route", "我来分析这个岗位描述。", { routeTo: "strategist", confidence: 0.8 });
  }
  return dec("frontdesk", "final", PRODUCT_INTRO, { confidence: 0.7 });
}

// ── ExperienceReceiver ───────────────────────────────────
// Only 2 paths: save (when text is substantial) or list.

function experienceReceiverFallback(rawMessage: string): AgentDecision {
  const msg = lower(rawMessage);
  const asksSaveJD = containsAny(msg, ["保存", "入库", "记录", "save"]);
  // JD matching intent: if JD keywords present, use batch match tool
  if (containsAny(msg, ["jd", "岗位", "job", "匹配", "符合", "适合"]) && containsAny(msg, ["经历", "experience"])) {
    return dec(
      "experience_receiver",
      "plan",
      "我来对比你的经历库和这份 JD。",
      {
        plan: [
          step("step-1", "experience_receiver", "match_experiences_against_jd", { jdText: rawMessage, limit: 20 }, "Match all experiences against JD."),
          ...(asksSaveJD
            ? [step("step-2", "experience_receiver", "save_jd_from_text", { text: rawMessage }, "Save JD after showing match results.")]
            : []),
        ],
        confidence: 0.8,
      },
    );
  }
  if (rawMessage.length > 30) {
    return dec(
      "experience_receiver",
      "plan",
      "我先整理一下这段经历，然后需要你确认保存。",
      {
        plan: [
          step("step-1", "experience_receiver", "import_experience_candidates_from_text", { text: rawMessage }, "Recognize experience candidates from user text."),
        ],
        confidence: 0.8,
      },
    );
  }
  return dec(
    "experience_receiver",
    "plan",
    "我来查看你的经历库。",
    {
      plan: [
        step("step-1", "experience_receiver", "list_experiences", {}, "List all experiences."),
      ],
      confidence: 0.9,
    },
  );
}

// ── Strategist ───────────────────────────────────────────
// Single safe path: list experiences.

function strategistFallback(): AgentDecision {
  return dec(
    "strategist",
    "plan",
    "我来查看你的经历库以便分析。",
    {
      plan: [
        step("step-1", "strategist", "list_experiences", {}, "List all experiences for strategy analysis."),
      ],
      confidence: 0.7,
    },
  );
}

// ── Architect ────────────────────────────────────────────
// Only 2 paths: export or list.

function architectFallback(msg: string, clientState: Record<string, unknown>): AgentDecision {
  const exportId = msg.match(/\bexport-[a-z0-9-]+\b/i)?.[0];
  if (exportId && containsAny(msg, ["下载", "download", "导出任务", "export"])) {
    return dec(
      "architect",
      "plan",
      "我来检查这条导出任务的文件状态。",
      {
        plan: [
          step("step-1", "architect", "get_export", { id: exportId }, "Get export download status."),
        ],
        confidence: 0.9,
      },
    );
  }
  if (containsAny(msg, ["生成", "generate"]) && containsAny(msg, ["简历", "resume"])) {
    const jdText = containsAny(msg, ["jd", "岗位", "职责", "任职要求"]) ? msg : undefined;
    return dec(
      "architect",
      "plan",
      "我会先匹配经历，再在你确认后基于 JD 生成简历。",
      {
        plan: [
          step("step-1", "architect", "match_experiences_against_jd", { jdText, limit: 20 }, "Match experiences against JD."),
          step("step-2", "architect", "generate_resume_from_jd", {}, "Generate resume from JD after confirmation."),
        ],
        confidence: 0.8,
      },
    );
  }
  if (containsAny(msg, ["export", "导出"])) {
    const resumeId = clientState.activeResumeId as string | undefined;
    return dec(
      "architect",
      "plan",
      "我来准备导出你的简历。",
      {
        plan: [
          step("step-1", "architect", "prepare_export_resume", { resumeId: resumeId ?? "current" }, "Prepare resume for export."),
        ],
        confidence: 0.8,
      },
    );
  }
  return dec(
    "architect",
    "plan",
    "我来查看简历列表。",
    {
      plan: [
        step("step-1", "architect", "list_resumes", {}, "List all resumes."),
      ],
      confidence: 0.7,
    },
  );
}

// ── Critic ───────────────────────────────────────────────
// Single safe path: check unsupported claims.

function criticFallback(): AgentDecision {
  return dec(
    "critic",
    "plan",
    "我来检查经历中的潜在风险。",
    {
      plan: [
        step("step-1", "critic", "check_unsupported_claims", {}, "Check all experiences for unsupported claims."),
      ],
      confidence: 0.7,
    },
  );
}

function containsAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}
