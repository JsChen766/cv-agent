import { describe, expect, it } from "vitest";
import { NarratorService } from "../src/copilot/response/NarratorService.js";

describe("NarratorService", () => {
  it("returns null when modelClient is missing (degrades silently)", async () => {
    const narrator = new NarratorService({ modelClient: undefined, prompt: "system", enabled: true });
    const result = await narrator.narrate({
      locale: "zh-CN",
      userMessage: "请帮我生成简历",
      toolResults: [{ status: "success", actionResult: { status: "success", actionType: "generate_resume_from_jd" } }],
      branch: "generated",
    });
    expect(result).toBeNull();
  });

  it("returns null when disabled even if modelClient is provided", async () => {
    const stub = { chat: async () => ({ content: "should not be called" }) } as any;
    const narrator = new NarratorService({ modelClient: stub, prompt: "system", enabled: false });
    const result = await narrator.narrate({ locale: "zh-CN", userMessage: "x", toolResults: [], branch: "generated" });
    expect(result).toBeNull();
  });
});

function makeStubModelClient(responses: Array<string | Error>) {
  let i = 0;
  return {
    chat: async () => {
      const next = responses[i++] ?? "";
      if (next instanceof Error) throw next;
      return { content: next };
    },
  } as any;
}

describe("NarratorService LLM path", () => {
  it("calls modelClient.chat and returns trimmed assistant text on success", async () => {
    const stub = makeStubModelClient(["  已基于 JD 生成 3 个简历版本，你可以选一个版本保存。  "]);
    const narrator = new NarratorService({ modelClient: stub, prompt: "SYS", enabled: true });
    const result = await narrator.narrate({
      locale: "zh-CN",
      userMessage: "请帮我生成简历",
      toolResults: [{
        status: "success",
        message: "已基于 JD 生成 3 个简历版本",
        resultKind: "generation_completed",
        summaryFacts: ["Generated 3 variants"],
        nextActionHints: [{ type: "accept_generation_variant", label: "选择并保存一个版本" }],
        actionResult: { status: "success", actionType: "generate_resume_from_jd" },
      }],
      branch: "generated",
    });
    expect(result).toBe("已基于 JD 生成 3 个简历版本，你可以选一个版本保存。");
  });

  it("returns null when modelClient throws (caller falls back)", async () => {
    const stub = makeStubModelClient([new Error("provider down")]);
    const narrator = new NarratorService({ modelClient: stub, prompt: "SYS", enabled: true });
    const result = await narrator.narrate({
      locale: "zh-CN",
      userMessage: "x",
      toolResults: [{ status: "success", actionResult: { status: "success", actionType: "generate_resume_from_jd" } }],
      branch: "generated",
    });
    expect(result).toBeNull();
  });

  it("returns null when modelClient returns blank content", async () => {
    const stub = makeStubModelClient(["   \n  "]);
    const narrator = new NarratorService({ modelClient: stub, prompt: "SYS", enabled: true });
    const result = await narrator.narrate({
      locale: "zh-CN",
      userMessage: "x",
      toolResults: [{ status: "success", actionResult: { status: "success", actionType: "generate_resume_from_jd" } }],
      branch: "generated",
    });
    expect(result).toBeNull();
  });
});
