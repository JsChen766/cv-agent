import { describe, expect, it } from "vitest";
import { FrontDeskAgent } from "../src/agents/frontdesk/FrontDeskAgent.js";
import { ModelClient } from "../src/core/model/ModelClient.js";
import type { LLMProvider } from "../src/core/model/LLMProvider.js";
import type { LLMChatRequest, LLMChatResponse } from "../src/core/model/types.js";
import type { CopilotSession } from "../src/copilot/types.js";

class CapturingProvider implements LLMProvider {
  public readonly name = "capturing";
  public requests: LLMChatRequest[] = [];

  public async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    this.requests.push(request);
    return {
      content: JSON.stringify({
        mode: "respond",
        assistantMessage: "ok",
        confidence: 1,
      }),
    };
  }
}

describe("runtime FrontDeskAgent", () => {
  it("passes clientState into the decision payload and prompt guidance", async () => {
    const provider = new CapturingProvider();
    const agent = new FrontDeskAgent({
      modelClient: new ModelClient({
        provider,
        defaultModel: "fake",
        maxRetries: 0,
      }),
    });
    const clientState = {
      activeResumeItemId: "item-123",
      selectedText: "Selected resume text",
      intentSource: "composer" as const,
    };

    await agent.decide({
      requestId: "req-frontdesk",
      sessionId: "session-1",
      message: "这段怎么改？",
      request: { message: "这段怎么改？", clientState },
      session: session(),
      workspace: null,
      recentMessages: [],
      tools: [],
    });

    const systemPrompt = provider.requests[0]?.messages[0]?.content;
    const userPayload = JSON.parse(String(provider.requests[0]?.messages[1]?.content)) as {
      requestContext: { clientState: unknown };
    };

    expect(systemPrompt).toContain("requestContext.clientState");
    expect(userPayload.requestContext.clientState).toEqual(clientState);
  });
});

function session(): CopilotSession {
  const now = new Date().toISOString();
  return {
    id: "session-1",
    userId: "user-1",
    status: "active",
    resumeIngested: false,
    createdAt: now,
    updatedAt: now,
  };
}
