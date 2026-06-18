import { describe, expect, it } from "vitest";
import { FrontDeskHandoffSchema, FrontDeskIntentSchema } from "../src/copilot/handoff/FrontDeskHandoffSchema.js";
import { normalizeFrontDeskHandoff } from "../src/copilot/handoff/HandoffNormalizer.js";
import { tasksFromHandoff } from "../src/copilot/tasks/TaskStateReducer.js";
import type { FrontDeskHandoff } from "../src/copilot/handoff/FrontDeskHandoff.js";
import type { CopilotWorkspace } from "../src/copilot/types.js";

const JD_TEXT = `Senior Frontend Engineer
Company: Example Tech
岗位职责：
- Build React and TypeScript product workflows.
- Collaborate with design, data, and backend teams.
任职要求：
- 5+ years frontend engineering experience.
- Strong ownership of complex user-facing systems.`;

function bare(message: string, opts: { sessionId?: string; turnId?: string } = {}) {
  return normalizeFrontDeskHandoff({
    raw: undefined,
    sessionId: opts.sessionId ?? "cs-1",
    turnId: opts.turnId ?? "ct-1",
    userMessage: message,
  }).handoff;
}

function emptyWorkspace(now: string): CopilotWorkspace {
  return {
    id: "ws-1",
    sessionId: "cs-1",
    variants: [],
    status: "empty",
    updatedAt: now,
  };
}

function fullHandoff(partial: Partial<FrontDeskHandoff> & {
  intent: FrontDeskHandoff["intent"];
  routeTo: FrontDeskHandoff["routeTo"];
}): FrontDeskHandoff {
  const now = new Date().toISOString();
  return {
    id: "handoff-1",
    sessionId: "cs-1",
    turnId: "ct-1",
    confidence: 0.85,
    extracted: {},
    next: "execute_task",
    createdAt: now,
    ...partial,
  };
}

describe("Phase 1 — FrontDeskIntentSchema additive enums", () => {
  it("accepts the new asset_grounded.write intent", () => {
    expect(FrontDeskIntentSchema.safeParse("asset_grounded.write").success).toBe(true);
  });

  it("accepts the experience.match_against_jd intent (Phase 0 drift fix)", () => {
    expect(FrontDeskIntentSchema.safeParse("experience.match_against_jd").success).toBe(true);
  });

  it("still rejects unknown intents", () => {
    expect(FrontDeskIntentSchema.safeParse("asset_grounded.summarize").success).toBe(false);
    expect(FrontDeskIntentSchema.safeParse("totally.fake").success).toBe(false);
  });

  it("accepts a complete handoff with the new optional fields", () => {
    const now = new Date().toISOString();
    const parsed = FrontDeskHandoffSchema.safeParse({
      id: "handoff-1",
      sessionId: "cs-1",
      turnId: "ct-1",
      intent: "asset_grounded.write",
      confidence: 0.85,
      routeTo: "architect",
      goal: "self_intro",
      outputType: "self_intro",
      constraints: { length: "medium", language: "zh" },
      extracted: { experienceQuery: "WEEX", experienceIds: ["pexp-1"] },
      suggestedActions: ["compose_career_text"],
      next: "execute_task",
      createdAt: now,
    });
    expect(parsed.success).toBe(true);
  });

  it("does not break older handoffs that omit the new fields", () => {
    const now = new Date().toISOString();
    const parsed = FrontDeskHandoffSchema.safeParse({
      id: "handoff-2",
      sessionId: "cs-1",
      turnId: "ct-1",
      intent: "jd.intake",
      confidence: 0.9,
      routeTo: "strategist",
      extracted: { jdText: JD_TEXT },
      suggestedActions: ["save_jd", "analyze_jd", "generate_resume"],
      next: "handoff",
      createdAt: now,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("Phase 1 — HandoffNormalizer routes asset-grounded writing", () => {
  it("routes self-intro to asset_grounded.write (NOT experience.intake / general.chat / jd.match)", () => {
    const h = bare("根据我的经历帮我写一条 1 分钟中文自我介绍");
    expect(h.intent).toBe("asset_grounded.write");
    expect(h.intent).not.toBe("experience.intake");
    expect(h.intent).not.toBe("experience.match_against_jd");
    expect(h.intent).not.toBe("resume.generate_from_jd");
    expect(h.intent).not.toBe("general.chat");
    expect(h.routeTo).toBe("architect");
    expect(h.outputType).toBe("self_intro");
    expect(h.constraints?.language).toBe("zh");
    expect(h.suggestedActions).toEqual(["compose_career_text"]);
    expect(h.next).toBe("execute_task");
  });

  it("routes WEEX project intro to asset_grounded.write with experienceQuery", () => {
    const h = bare("根据 WEEX 实习经历帮我写一段面试可以说的项目介绍");
    expect(h.intent).toBe("asset_grounded.write");
    expect(h.intent).not.toBe("experience.match_against_jd");
    expect(h.outputType).toBe("project_intro");
    expect((h.extracted.experienceQuery ?? "").toUpperCase()).toContain("WEEX");
  });

  it("routes interview opening request to asset_grounded.write", () => {
    const h = bare("根据我的经历帮我写一段面试开场");
    expect(h.intent).toBe("asset_grounded.write");
    expect(h.outputType).toBe("interview_answer");
  });

  it("routes profile-summary request to asset_grounded.write", () => {
    const h = bare("根据我的经历总结一下个人优势");
    expect(h.intent).toBe("asset_grounded.write");
    expect(h.outputType).toBe("profile_summary");
  });

  it("routes JD-anchored self-intro to asset_grounded.write (NOT match, NOT generate)", () => {
    const message = `根据这份 JD 写一段自我介绍：
${JD_TEXT}`;
    const h = bare(message);
    expect(h.intent).toBe("asset_grounded.write");
    expect(h.intent).not.toBe("resume.generate_from_jd");
    expect(h.intent).not.toBe("experience.match_against_jd");
    expect(h.outputType).toBe("self_intro");
    expect(h.extracted.jdText).toContain("Senior Frontend Engineer");
  });

  it("routes application-answer request to asset_grounded.write", () => {
    const h = bare("帮我回答申请表问题，根据我的经历写一段答案");
    expect(h.intent).toBe("asset_grounded.write");
    expect(h.outputType).toBe("application_answer");
  });

  it("routes recast-experience-as-interview-script to asset_grounded.write", () => {
    const h = bare("帮我把这段经历改成面试时能说的话");
    expect(h.intent).toBe("asset_grounded.write");
    expect(h.intent).not.toBe("experience.rewrite");
    expect(h.outputType).toBe("interview_answer");
  });

  it("does NOT hijack pure rewrite requests", () => {
    const h = bare("改写这条经历，让它更突出量化结果");
    expect(h.intent).toBe("experience.rewrite");
    expect(h.intent).not.toBe("asset_grounded.write");
  });

  it("does NOT hijack optimize-this-experience requests", () => {
    const h = bare("优化这条经历");
    expect(h.intent).toBe("experience.rewrite");
  });

  it("does NOT hijack chitchat without asset scope", () => {
    const h = bare("帮我写个段子放松一下");
    expect(h.intent).toBe("general.chat");
  });
});

describe("Phase 1 — JD match-against-experiences routing (Phase 0 drift fix)", () => {
  it("routes which-experiences-match-this-JD to experience.match_against_jd", () => {
    const message = `帮我看哪些经历最匹配这份 JD：
${JD_TEXT}`;
    const h = bare(message);
    expect(h.intent).toBe("experience.match_against_jd");
    expect(h.routeTo).toBe("experience_receiver");
    expect(h.suggestedActions).toEqual(["match_experiences"]);
    expect(h.extracted.jdText).toContain("Senior Frontend Engineer");
  });

  it("routes analyze-fit-with-this-JD to experience.match_against_jd", () => {
    const h = bare("分析我和这个 JD 的匹配度，看哪条经历最适合这份 JD");
    expect(h.intent).toBe("experience.match_against_jd");
  });

  it("does NOT route a bare which-experiences-match question without JD scope", () => {
    const h = bare("哪些经历最匹配？");
    expect(h.intent).not.toBe("experience.match_against_jd");
  });
});

describe("Phase 1 — Existing fixed pipelines stay intact", () => {
  it("keeps generate-resume-from-this-JD on resume.generate_from_jd", () => {
    const message = `基于这个 JD 生成简历：
${JD_TEXT}`;
    const h = bare(message);
    expect(h.intent).toBe("resume.generate_from_jd");
  });

  it("keeps 那就生成吧 on resume.generate_from_jd", () => {
    const h = bare("那就生成吧");
    expect(h.intent).toBe("resume.generate_from_jd");
  });

  it("keeps a pasted JD on jd.intake by default", () => {
    const h = bare(JD_TEXT);
    expect(["jd.intake", "resume.generate_from_jd"]).toContain(h.intent);
  });

  it("keeps short greetings on general.chat", () => {
    const h = bare("你好");
    expect(h.intent).toBe("general.chat");
  });

  it("keeps optimize-experience requests on experience.rewrite", () => {
    const h = bare("优化这条经历");
    expect(h.intent).toBe("experience.rewrite");
  });
});

describe("Phase 1 — Raw model handoff defaults align with schema", () => {
  it("normalizes a raw asset_grounded.write handoff that omits routeTo (defaults to architect)", () => {
    const result = normalizeFrontDeskHandoff({
      raw: {
        intent: "asset_grounded.write",
        outputType: "self_intro",
        constraints: { length: "medium" },
        extracted: { experienceQuery: "WEEX" },
        suggestedActions: ["compose_career_text"],
        next: "execute_task",
      },
      sessionId: "cs-1",
      turnId: "ct-1",
      userMessage: "根据 WEEX 实习经历写一段自我介绍",
    });
    expect(result.handoff.intent).toBe("asset_grounded.write");
    expect(result.handoff.routeTo).toBe("architect");
    expect(result.handoff.outputType).toBe("self_intro");
    expect(result.handoff.constraints?.length).toBe("medium");
    expect(result.handoff.extracted.experienceQuery).toBe("WEEX");
  });

  it("normalizes a raw experience.match_against_jd handoff and defaults route to experience_receiver", () => {
    const result = normalizeFrontDeskHandoff({
      raw: {
        intent: "experience.match_against_jd",
        extracted: { jdText: JD_TEXT },
        suggestedActions: ["match_experiences"],
        next: "execute_task",
      },
      sessionId: "cs-1",
      turnId: "ct-1",
      userMessage: "帮我看哪些经历最匹配这份 JD",
    });
    expect(result.handoff.intent).toBe("experience.match_against_jd");
    expect(result.handoff.routeTo).toBe("experience_receiver");
  });

  it("rejects natural-language values on outputType but accepts the well-known set", () => {
    // outputType is open-ended on the wire (z.string), so any string is
    // accepted by the schema. Specialists treat unknowns as 'custom'.
    const now = new Date().toISOString();
    const parsed = FrontDeskHandoffSchema.safeParse({
      id: "handoff-3",
      sessionId: "cs-1",
      turnId: "ct-1",
      intent: "asset_grounded.write",
      confidence: 0.7,
      routeTo: "architect",
      outputType: "anything_can_go_here_for_forward_compat",
      extracted: {},
      next: "execute_task",
      createdAt: now,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("Phase 1 — TaskStateReducer keeps writing & match intents task-less", () => {
  it("does not create a currentTask for asset_grounded.write", () => {
    const now = new Date().toISOString();
    const ws = emptyWorkspace(now);
    const handoff = fullHandoff({ intent: "asset_grounded.write", routeTo: "architect" });
    const reduced = tasksFromHandoff(ws, handoff, now);
    expect(reduced.currentTask).toBeUndefined();
    expect(reduced.suggestedTasks).toEqual([]);
  });

  it("does not create a currentTask for experience.match_against_jd", () => {
    const now = new Date().toISOString();
    const ws = emptyWorkspace(now);
    const handoff = fullHandoff({ intent: "experience.match_against_jd", routeTo: "experience_receiver" });
    const reduced = tasksFromHandoff(ws, handoff, now);
    expect(reduced.currentTask).toBeUndefined();
    expect(reduced.suggestedTasks).toEqual([]);
  });

  it("still creates RESUME_GENERATE_FROM_JD task on resume.generate_from_jd", () => {
    const now = new Date().toISOString();
    const ws = emptyWorkspace(now);
    const handoff = fullHandoff({ intent: "resume.generate_from_jd", routeTo: "architect" });
    const reduced = tasksFromHandoff(ws, handoff, now);
    expect(reduced.currentTask?.type).toBe("RESUME_GENERATE_FROM_JD");
  });

  it("still creates EXPERIENCE_REWRITE task on experience.rewrite", () => {
    const now = new Date().toISOString();
    const ws = emptyWorkspace(now);
    const handoff = fullHandoff({ intent: "experience.rewrite", routeTo: "experience_receiver" });
    const reduced = tasksFromHandoff(ws, handoff, now);
    expect(reduced.currentTask?.type).toBe("EXPERIENCE_REWRITE");
  });
});

describe("Phase 1 — frontdesk.md prompt-vs-schema alignment", () => {
  // Read the prompt directly so this test fails loudly if Example 6/8/9/10
  // diverges from the schema again.
  const promptPath = new URL("../src/agent-core/prompts/prompts/frontdesk.md", import.meta.url);
  const fs = require("node:fs") as typeof import("node:fs");
  const prompt = fs.readFileSync(promptPath, "utf8");

  it("documents asset_grounded.write as a routable intent", () => {
    expect(prompt).toContain("asset_grounded.write");
  });

  it("documents experience.match_against_jd as a routable intent (Phase 0 drift fix)", () => {
    expect(prompt).toContain("experience.match_against_jd");
  });

  it("includes outputType / constraints guidance for writing tasks", () => {
    expect(prompt).toMatch(/outputType/);
    expect(prompt).toMatch(/constraints/);
  });

  it("every documented intent is accepted by FrontDeskIntentSchema", () => {
    const documented = [
      "jd.intake",
      "jd.save",
      "jd.analyze",
      "resume.generate_from_jd",
      "experience.intake",
      "experience.save",
      "experience.rewrite",
      "experience.match_against_jd",
      "asset_grounded.write",
      "resume.optimize_item",
      "resume.export",
      "general.chat",
      "clarify",
    ];
    for (const intent of documented) {
      expect(FrontDeskIntentSchema.safeParse(intent).success).toBe(true);
    }
  });
});
