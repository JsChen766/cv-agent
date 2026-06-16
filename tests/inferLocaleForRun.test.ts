import { describe, expect, it } from "vitest";
import { inferLocaleForRun } from "../src/agent-core/runtime/AgentOrchestrator.js";
import type { RunState } from "../src/agent-core/runtime/RunState.js";
import type { FrontDeskHandoff } from "../src/copilot/handoff/FrontDeskHandoff.js";

function makeHandoff(userGoal: string): FrontDeskHandoff {
  return {
    id: "ho-1",
    turnId: "turn-1",
    sessionId: "sess-1",
    intent: "general.chat",
    confidence: 1,
    routeTo: "frontdesk",
    userGoal,
    extracted: {},
    next: "answer_directly",
    createdAt: new Date().toISOString(),
  };
}

function makeRun(overrides: {
  userMessage: string;
  locale?: string;
  handoffs?: FrontDeskHandoff[];
}): RunState {
  return {
    context: {
      userMessage: overrides.userMessage,
      clientState: overrides.locale ? { locale: overrides.locale } : undefined,
    },
    workspace: overrides.handoffs ? { handoffs: overrides.handoffs } : null,
  } as unknown as RunState;
}

describe("inferLocaleForRun", () => {
  it("returns zh-CN when clientState.locale is zh-CN regardless of message", () => {
    const run = makeRun({ userMessage: "[action] generate_resume_from_jd", locale: "zh-CN" });
    expect(inferLocaleForRun(run)).toBe("zh-CN");
  });

  it("returns en when clientState.locale is en regardless of message", () => {
    const run = makeRun({ userMessage: "你好，我想生成简历", locale: "en" });
    expect(inferLocaleForRun(run)).toBe("en");
  });

  it("falls through to detectLocale when message is normal Chinese chat", () => {
    const run = makeRun({ userMessage: "你好，我想根据一份 JD 生成简历。" });
    expect(inferLocaleForRun(run)).toBe("zh-CN");
  });

  it("falls through to detectLocale when message is normal English chat", () => {
    const run = makeRun({ userMessage: "Hello, please help me generate a resume." });
    expect(inferLocaleForRun(run)).toBe("en");
  });

  it("walks back to the latest Chinese handoff userGoal when message is [action] ...", () => {
    const run = makeRun({
      userMessage: "[action] generate_resume_from_jd",
      handoffs: [
        makeHandoff("[action] save_jd"),
        makeHandoff("你好，我想根据一份 JD 生成简历。"),
        makeHandoff("[confirm] save_jd"),
      ],
    });
    expect(inferLocaleForRun(run)).toBe("zh-CN");
  });

  it("walks back to the latest English handoff userGoal when message is [confirm] ...", () => {
    const run = makeRun({
      userMessage: "[confirm] save_jd",
      handoffs: [makeHandoff("Please save the JD I just pasted.")],
    });
    expect(inferLocaleForRun(run)).toBe("en");
  });

  it("falls back to detectLocale on the placeholder when no natural-language handoff exists", () => {
    const run = makeRun({
      userMessage: "[action] generate_resume_from_jd",
      handoffs: [makeHandoff("[action] save_jd")],
    });
    // No natural-language signal anywhere → detectLocale on pure ASCII placeholder → en.
    expect(inferLocaleForRun(run)).toBe("en");
  });

  it("falls back to detectLocale when workspace is null", () => {
    const run = makeRun({ userMessage: "[action] generate_resume_from_jd" });
    expect(inferLocaleForRun(run)).toBe("en");
  });

  it("uses the most recent Chinese handoff even when newer handoffs exist as placeholders", () => {
    const run = makeRun({
      userMessage: "[action] export_resume",
      handoffs: [
        makeHandoff("Old English message"),
        makeHandoff("最近的中文消息，应该被采用"),
        makeHandoff("[confirm] save_jd"),
        makeHandoff("[action] generate_resume_from_jd"),
      ],
    });
    expect(inferLocaleForRun(run)).toBe("zh-CN");
  });
});
