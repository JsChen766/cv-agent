import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/api/createServer.js";
import type { ApiSuccess } from "../src/api/response.js";
import type { ApiKernel } from "../src/api/types.js";
import type { CopilotChatResponse } from "../src/copilot/types.js";
import { createP12Kernel } from "./p12Helpers.js";

describe("JD match orchestration", () => {
  let kernel: ApiKernel;
  let server: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    kernel = await createP12Kernel();
    server = await createServer(kernel);
  });

  afterEach(async () => {
    await server.close();
    await kernel.close();
  });

  it("matches JD with structured block, short assistant text, save action, and no auto-save", async () => {
    await seedExperiences(kernel);
    const jdBefore = await kernel.productServices.jdService.listJDs("user-1", 20);

    const jdText = "前端工程师 JD：要求 Vue3、TypeScript、数据可视化能力，负责业务中台页面与性能优化。";
    const chatResponse = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: { message: `根据这个 JD 匹配经历：${jdText}` },
    });

    expect(chatResponse.statusCode).toBe(200);
    const body = chatResponse.json() as ApiSuccess<CopilotChatResponse>;
    const rawToolResults = body.data.raw.toolResults as Array<Record<string, unknown>> | undefined;
    const matchResult = rawToolResults?.find((item) => {
      const ar = item.actionResult as Record<string, unknown> | undefined;
      return ar?.actionType === "match_experiences_against_jd";
    });

    expect(matchResult).toBeTruthy();

    const matchData = (matchResult?.data ?? {}) as Record<string, unknown>;
    const topResults = (matchData.topResults ?? {}) as Record<string, unknown>;
    const sampleTitle = ([...(topResults.high as unknown[] ?? []), ...(topResults.medium as unknown[] ?? []), ...(topResults.low as unknown[] ?? [])][0] as Record<string, unknown> | undefined)?.title;

    const assistantText = body.data.assistantMessage.content;
    expect(assistantText).toBeTruthy();
    if (typeof sampleTitle === "string" && sampleTitle.length > 0) {
      expect(assistantText).not.toContain(sampleTitle);
    }

    const blocks = body.data.assistantMessage.metadata?.productBlocks as Array<{ type: string; data?: Record<string, unknown> }> | undefined;
    const matchBlock = blocks?.find((item) => item.type === "experience_match_results" || item.type === "jd_match_results");
    expect(matchBlock).toBeTruthy();
    expect(matchBlock?.data?.summary).toBeTruthy();
    expect(matchBlock?.data?.jdSummary).toBeTruthy();
    expect(matchBlock?.data?.topResults).toBeTruthy();
    expect(Array.isArray(matchBlock?.data?.matchResults)).toBe(true);

    const blockSaveAction = (matchBlock?.data?.saveJDAction as Record<string, unknown> | undefined)
      ?? ((matchBlock?.data?.actions as Array<Record<string, unknown>> | undefined) ?? []).find((a) => a.type === "save_jd_from_text");
    expect(blockSaveAction).toBeTruthy();
    const payload = (blockSaveAction?.payload as Record<string, unknown> | undefined) ?? {};
    expect(payload.jdText ?? payload.rawText).toBeTruthy();
    expect(typeof payload.jdHash).toBe("string");
    const blockActions = (matchBlock?.data?.actions as Array<Record<string, unknown>> | undefined) ?? [];
    expect(blockActions.some((action) => action.type === "save_jd_from_text" && (action.payload as Record<string, unknown> | undefined)?.generateAfterSave === true)).toBe(true);
    expect(blockActions.some((action) => action.type === "generate_from_jd")).toBe(true);
    expect(body.data.nextActions.some((action) => action.type === "save_jd_from_text")).toBe(false);

    const jdAfter = await kernel.productServices.jdService.listJDs("user-1", 20);
    expect(jdAfter.length).toBe(jdBefore.length);
  });

  it("explicit save-and-match creates save_jd pending action and updates activeJDId after confirm", async () => {
    await seedExperiences(kernel);

    const response = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: {
        message: "保存这个JD并匹配经历：后端开发 JD，要求 Node.js、TypeScript、MySQL、CI/CD 经验。",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as ApiSuccess<CopilotChatResponse>;
    const pendingActions = (body.data.raw.pendingActions ?? []) as Array<{ id: string; toolName?: string }>;
    const pending = pendingActions.find((item) => item.toolName === "save_jd_from_text");
    expect(pending).toBeTruthy();
    const pendingDisplay = (body.data.raw.pendingActions ?? []) as Array<Record<string, unknown>>;
    const pendingCard = pendingDisplay.find((item) => item.toolName === "save_jd_from_text");
    expect(pendingCard?.title).toBe("保存 JD 到 JD 库");
    expect(pendingCard?.summary).toBe("请确认是否将这份 JD 保存到 JD 库。");
    const preview = pendingCard?.preview as Record<string, unknown> | undefined;
    const jdDraft = (preview?.jdDraft as Record<string, unknown> | undefined)
      ?? ((preview?.after as Record<string, unknown> | undefined)?.jdDraft as Record<string, unknown> | undefined);
    expect(jdDraft).toBeTruthy();
    expect(typeof jdDraft?.rawText).toBe("string");

    const jdsBeforeConfirm = await kernel.productServices.jdService.listJDs("user-1", 20);
    expect(jdsBeforeConfirm.length).toBe(0);

    const confirm = await server.inject({
      method: "POST",
      url: `/copilot/pending-actions/${pending!.id}/confirm`,
      headers: { "x-user-id": "user-1" },
    });

    expect(confirm.statusCode).toBe(200);
    const confirmBody = confirm.json() as ApiSuccess<CopilotChatResponse>;
    expect(confirmBody.data.workspace.jdId).toBeTruthy();
    expect(confirmBody.data.workspace.active?.jdId).toBeTruthy();

    const jdsAfterConfirm = await kernel.productServices.jdService.listJDs("user-1", 20);
    expect(jdsAfterConfirm.length).toBe(1);
    expect(jdsAfterConfirm[0]?.id).toBe(confirmBody.data.workspace.jdId);

    const detail = await server.inject({
      method: "GET",
      url: `/copilot/sessions/${body.data.sessionId}`,
      headers: { "x-user-id": "user-1" },
    });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json() as ApiSuccess<{ messages: Array<{ role: string; metadata?: Record<string, unknown> }> }>;
    const assistant = detailBody.data.messages.find((item) => item.role === "assistant");
    const snapshot = assistant?.metadata?.displaySnapshot as Record<string, unknown> | undefined;
    const pendingSnapshot = (snapshot?.pendingActions as Array<Record<string, unknown>> | undefined) ?? [];
    const savePending = pendingSnapshot.find((item) => item.toolName === "save_jd_from_text");
    expect(savePending?.status).toBe("executed");
    const persistedPreview = savePending?.preview as Record<string, unknown> | undefined;
    const persistedDraft = (persistedPreview?.jdDraft as Record<string, unknown> | undefined)
      ?? ((persistedPreview?.after as Record<string, unknown> | undefined)?.jdDraft as Record<string, unknown> | undefined);
    expect(persistedDraft?.preview).toBeTruthy();
  });

  it("duplicate confirm and duplicate save actions only persist one JD", async () => {
    const text = "save this JD and match experiences: Backend Engineer, Node.js, TypeScript, MySQL.";
    const first = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: { message: text },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as ApiSuccess<CopilotChatResponse>;
    const firstPendingActions = (firstBody.data.raw.pendingActions ?? []) as Array<Record<string, unknown>>;
    const pending = firstPendingActions.find((item) => item.toolName === "save_jd_from_text");
    expect(pending?.id).toBeTruthy();

    const confirmOnce = await server.inject({
      method: "POST",
      url: `/copilot/pending-actions/${String(pending!.id)}/confirm`,
      headers: { "x-user-id": "user-1" },
    });
    expect(confirmOnce.statusCode).toBe(200);

    const confirmTwice = await server.inject({
      method: "POST",
      url: `/copilot/pending-actions/${String(pending!.id)}/confirm`,
      headers: { "x-user-id": "user-1" },
    });
    expect(confirmTwice.statusCode).toBe(200);

    const second = await server.inject({
      method: "POST",
      url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: {
        sessionId: firstBody.data.sessionId,
        action: {
          type: "save_jd_from_text",
          payload: { jdText: text, rawText: text },
        },
      },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as ApiSuccess<CopilotChatResponse>;
    const secondPendingActions = (secondBody.data.raw.pendingActions ?? []) as Array<Record<string, unknown>>;
    const secondPending = secondPendingActions.find((item) => item.toolName === "save_jd_from_text");
    expect(secondPending?.id).toBeTruthy();

    const secondConfirm = await server.inject({
      method: "POST",
      url: `/copilot/pending-actions/${String(secondPending!.id)}/confirm`,
      headers: { "x-user-id": "user-1" },
    });
    expect(secondConfirm.statusCode).toBe(200);
    const secondConfirmBody = secondConfirm.json() as ApiSuccess<CopilotChatResponse>;
    const actionResult = (secondConfirmBody.data.raw.actionResults ?? [])[0] as Record<string, unknown> | undefined;
    expect(actionResult?.status).toBe("success");
    const metadata = actionResult?.metadata as Record<string, unknown> | undefined;
    expect(metadata?.duplicate).toBe(true);

    const all = await kernel.productServices.jdService.listJDs("user-1", 20);
    expect(all.length).toBe(1);
  });

  it("session detail keeps jd match block and save action in productBlocks/displaySnapshot", async () => {
    await seedExperiences(kernel);

    const chat = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: {
        message: "根据这个 JD 匹配经历：产品经理 JD，要求用户研究、A/B 测试、跨团队协作。",
      },
    });

    expect(chat.statusCode).toBe(200);
    const chatBody = chat.json() as ApiSuccess<CopilotChatResponse>;

    const detail = await server.inject({
      method: "GET",
      url: `/copilot/sessions/${chatBody.data.sessionId}`,
      headers: { "x-user-id": "user-1" },
    });

    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json() as ApiSuccess<{ messages: Array<{ role: string; metadata?: Record<string, unknown> }> }>;
    const assistant = detailBody.data.messages.find((m) => m.role === "assistant");
    expect(assistant).toBeTruthy();

    const metadata = assistant?.metadata as Record<string, unknown> | undefined;
    const blocks = metadata?.productBlocks as Array<{ type: string; data?: Record<string, unknown> }> | undefined;
    const matchBlock = blocks?.find((item) => item.type === "experience_match_results" || item.type === "jd_match_results");
    expect(matchBlock).toBeTruthy();

    const blockActions = (matchBlock?.data?.actions as Array<Record<string, unknown>> | undefined) ?? [];
    expect(blockActions.some((item) => item.type === "save_jd_from_text")).toBe(true);

    const displaySnapshot = metadata?.displaySnapshot as Record<string, unknown> | undefined;
    expect(displaySnapshot).toBeTruthy();
    const snapshotBlocks = displaySnapshot?.productBlocks as Array<{ type: string }> | undefined;
    expect(snapshotBlocks?.some((item) => item.type === "experience_match_results" || item.type === "jd_match_results")).toBe(true);
    const toolResults = (displaySnapshot?.toolResults as Array<Record<string, unknown>> | undefined) ?? [];
    expect(toolResults.some((item) => {
      const ar = item.actionResult as Record<string, unknown> | undefined;
      return ar?.actionType === "match_experiences_against_jd";
    })).toBe(true);
  });

  it("direct generate action from match block creates one confirmation and confirmation returns export", async () => {
    await seedExperiences(kernel);
    const jdText = "前端工程师 JD：要求 Vue3、TypeScript、性能优化，负责业务中台页面。";
    const matchResponse = await server.inject({
      method: "POST",
      url: "/copilot/chat",
      headers: { "x-user-id": "user-1" },
      payload: { message: `先根据这个 JD 匹配经历：${jdText}` },
    });
    expect(matchResponse.statusCode).toBe(200);
    const matchBody = matchResponse.json() as ApiSuccess<CopilotChatResponse>;
    const blocks = matchBody.data.assistantMessage.metadata?.productBlocks as Array<{ type: string; data?: Record<string, unknown> }> | undefined;
    const matchBlock = blocks?.find((item) => item.type === "experience_match_results" || item.type === "jd_match_results");
    const actions = (matchBlock?.data?.actions as Array<Record<string, unknown>> | undefined) ?? [];
    const generateAction = actions.find((action) => action.type === "generate_from_jd");
    expect(generateAction).toBeTruthy();

    const actionResponse = await server.inject({
      method: "POST",
      url: "/copilot/actions",
      headers: { "x-user-id": "user-1" },
      payload: {
        sessionId: matchBody.data.sessionId,
        action: {
          type: "generate_from_jd",
          payload: generateAction?.payload,
        },
      },
    });
    expect(actionResponse.statusCode).toBe(200);
    const actionBody = actionResponse.json() as ApiSuccess<CopilotChatResponse>;
    const pendingActions = (actionBody.data.raw.pendingActions ?? []) as Array<{ id: string; toolName: string }>;
    expect(pendingActions.filter((action) => action.toolName === "generate_resume_from_jd")).toHaveLength(1);
    const pending = pendingActions.find((action) => action.toolName === "generate_resume_from_jd");
    expect(pending).toBeTruthy();

    const confirmResponse = await server.inject({
      method: "POST",
      url: `/copilot/pending-actions/${String(pending!.id)}/confirm`,
      headers: { "x-user-id": "user-1" },
    });
    expect(confirmResponse.statusCode).toBe(200);
    const confirmBody = confirmResponse.json() as ApiSuccess<CopilotChatResponse>;
    const actionResults = confirmBody.data.raw.actionResults ?? [];
    expect(actionResults.some((result) => result.actionType === "generate_resume_from_jd" && result.status === "success")).toBe(true);
    expect(actionResults.some((result) => result.actionType === "export_resume")).toBe(false);
    expect(confirmBody.data.raw.pendingActions ?? []).toHaveLength(0);
  });
});

async function seedExperiences(kernel: ApiKernel): Promise<void> {
  const inputs = [
    {
      title: "前端中台开发",
      category: "work" as const,
      content: "负责 Vue3 + TypeScript 中台开发，包含图表大屏与性能优化。",
      organization: "A 公司",
      role: "前端工程师",
    },
    {
      title: "数据分析项目",
      category: "project" as const,
      content: "使用 Python 与 SQL 做业务分析，搭建实验看板并推进 A/B 测试。",
      organization: "B 团队",
      role: "数据分析",
    },
  ];

  for (const input of inputs) {
    await kernel.productServices.experienceService.createExperience("user-1", {
      ...input,
      tags: [],
      source: "copilot",
    });
  }
}
