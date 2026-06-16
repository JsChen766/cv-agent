import { describe, expect, it } from "vitest";
import { ResponseComposer } from "../src/copilot/response/ResponseComposer.js";
import { NarratorService } from "../src/copilot/response/NarratorService.js";

function fakeContext(): any {
  return { productContext: {} };
}

function buildComposer(narratorReply: string | null): ResponseComposer {
  const stub = { chat: async () => ({ content: narratorReply ?? "" }) } as any;
  const narrator = new NarratorService({ modelClient: stub, prompt: "SYS", enabled: true });
  return new ResponseComposer({ narrator });
}

describe("ResponseComposer narrator wiring", () => {
  it("uses narrator output for the `generated` branch when ENABLE_NARRATOR is on", async () => {
    const composer = buildComposer("已基于 JD 生成 2 个版本，请选择一个保存。");
    const output = await composer.composeAsync({
      locale: "zh-CN",
      userMessage: "生成简历",
      workspace: null,
      toolResults: [{
        status: "success",
        actionResult: { status: "success", actionType: "generate_resume_from_jd" },
        data: { variants: [{ id: "v-1" }, { id: "v-2" }] },
      }],
      pendingActions: [],
      context: fakeContext(),
    });
    expect(output.assistantText).toBe("已基于 JD 生成 2 个版本，请选择一个保存。");
  });

  it("falls back to legacy text when narrator returns null", async () => {
    const composer = buildComposer(null);
    const output = await composer.composeAsync({
      locale: "zh-CN",
      userMessage: "生成简历",
      workspace: null,
      toolResults: [{
        status: "success",
        actionResult: { status: "success", actionType: "generate_resume_from_jd" },
        data: { variants: [{ id: "v-1" }] },
      }],
      pendingActions: [],
      context: fakeContext(),
    });
    expect(output.assistantText).toContain("已基于 JD 生成");
  });

  it("preserves nextActions on the `accepted` branch when narrator overrides text", async () => {
    const composer = buildComposer("已保存这个版本，可随时导出。");
    const output = await composer.composeAsync({
      locale: "zh-CN",
      userMessage: "保存",
      workspace: null,
      toolResults: [{
        status: "success",
        actionResult: { status: "success", actionType: "accept_generation_variant", metadata: { resumeId: "res-1" } },
      }],
      pendingActions: [],
      context: fakeContext(),
    });
    expect(output.assistantText).toBe("已保存这个版本，可随时导出。");
    expect(output.nextActions?.[0]).toMatchObject({ type: "export_resume", payload: { resumeId: "res-1" } });
  });

  it("does not call narrator on confirmation branch (deterministic UX)", async () => {
    let called = 0;
    const stub = { chat: async () => { called += 1; return { content: "should not appear" }; } } as any;
    const narrator = new NarratorService({ modelClient: stub, prompt: "SYS", enabled: true });
    const composer = new ResponseComposer({ narrator });
    const output = await composer.composeAsync({
      locale: "zh-CN",
      userMessage: "确认?",
      workspace: null,
      toolResults: [{
        status: "success",
        message: "我将把这个版本保存到你的简历中，请确认。",
        actionResult: { status: "needs_confirmation", actionType: "accept_generation_variant" },
      }],
      pendingActions: [],
      context: fakeContext(),
    });
    expect(called).toBe(0);
    expect(output.assistantText).toContain("我将把这个版本保存到你的简历中");
  });

  it("zero-arg constructor still composes without narrator (backward compat)", async () => {
    const composer = new ResponseComposer();
    const output = await composer.composeAsync({
      locale: "zh-CN",
      userMessage: "x",
      workspace: null,
      toolResults: [],
      pendingActions: [],
      context: fakeContext(),
    });
    expect(typeof output.assistantText).toBe("string");
  });
});
