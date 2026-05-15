import { describe, expect, it } from "vitest";
import { FrontDeskAgent } from "../src/agents/FrontDeskAgent.js";
import { ModelClient } from "../src/core/model/ModelClient.js";
import type { LLMProvider } from "../src/core/model/LLMProvider.js";
import type { LLMChatRequest, LLMChatResponse } from "../src/core/model/types.js";

class JsonProvider implements LLMProvider {
  public readonly name = "json";

  public constructor(private readonly content: string) {}

  public async chat(_request: LLMChatRequest): Promise<LLMChatResponse> {
    return { content: this.content };
  }
}

function createAgent(content: string): FrontDeskAgent {
  return new FrontDeskAgent({
    modelClient: new ModelClient({
      provider: new JsonProvider(content),
      defaultModel: "fake",
      maxRetries: 0,
    }),
    allowFallbackDecision: false,
  });
}

describe("FrontDeskAgent", () => {
  it("parses and validates FrontDeskDecision JSON", async () => {
    const agent = createAgent(JSON.stringify({
      intent: "ingest_resume_document",
      confidence: 0.91,
      summary: "Document import.",
      requiredActions: [{ type: "load_document", target: "documentLoader" }],
    }));

    await expect(agent.decide({
      userId: "user-1",
      message: "Import this resume.",
      hasDocument: true,
      documentFileNames: ["resume.md"],
    })).resolves.toEqual({
      intent: "ingest_resume_document",
      confidence: 0.91,
      summary: "Document import.",
      requiredActions: [{ type: "load_document", target: "documentLoader" }],
    });
  });

  it("rejects invalid FrontDeskDecision JSON", async () => {
    const agent = createAgent(JSON.stringify({
      intent: "not_supported",
      confidence: 2,
      summary: "Bad.",
      requiredActions: [],
    }));

    await expect(agent.decide({
      userId: "user-1",
      message: "hello",
    })).rejects.toThrow(/FrontDeskAgent decision schema validation failed/);
  });
});
