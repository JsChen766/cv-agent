import { describe, expect, it } from "vitest";
import { FrontDeskAgent } from "../src/agents/FrontDeskAgent.js";
import { ModelClient } from "../src/core/model/ModelClient.js";
import type { LLMProvider } from "../src/core/model/LLMProvider.js";
import type { LLMChatRequest, LLMChatResponse } from "../src/core/model/types.js";

class SequenceProvider implements LLMProvider {
  public readonly name = "sequence";
  public readonly requests: LLMChatRequest[] = [];
  private index = 0;

  public constructor(private readonly responses: string[]) {}

  public async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    this.requests.push(request);
    const content = this.responses[Math.min(this.index, this.responses.length - 1)] ?? "";
    this.index += 1;
    return { content };
  }
}

function createAgent(input: {
  responses: string[];
  allowJsonRepair?: boolean;
  allowFallbackDecision?: boolean;
}): {
  agent: FrontDeskAgent;
  provider: SequenceProvider;
} {
  const provider = new SequenceProvider(input.responses);
  return {
    provider,
    agent: new FrontDeskAgent({
      modelClient: new ModelClient({
        provider,
        defaultModel: "fake",
        maxRetries: 0,
      }),
      allowJsonRepair: input.allowJsonRepair,
      allowFallbackDecision: input.allowFallbackDecision,
    }),
  };
}

function decision(intent: string): string {
  return JSON.stringify({
    intent,
    confidence: 0.9,
    summary: `Route to ${intent}.`,
    requiredActions: [{ type: "route", target: "kernel" }],
  });
}

describe("FrontDeskAgent LLM behavior", () => {
  it("parses valid JSON responses", async () => {
    const { agent, provider } = createAgent({
      responses: [decision("generate_resume_for_jd")],
    });

    const result = await agent.decide({
      userId: "user-1",
      message: "Tailor my resume to this JD.",
    });

    expect(result.intent).toBe("generate_resume_for_jd");
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.temperature).toBe(0);
    expect(provider.requests[0]?.responseFormat).toBe("json");
  });

  it("parses fenced JSON responses", async () => {
    const { agent } = createAgent({
      responses: [[
        "```json",
        decision("ingest_resume_document"),
        "```",
      ].join("\n")],
    });

    await expect(agent.decide({
      userId: "user-1",
      message: "Import my resume.",
      hasDocument: true,
      documentFileNames: ["resume.md"],
    })).resolves.toMatchObject({
      intent: "ingest_resume_document",
    });
  });

  it("parses JSON with extra surrounding text", async () => {
    const { agent } = createAgent({
      responses: [`Here is the JSON: ${decision("show_experience_graph")} Thanks.`],
    });

    await expect(agent.decide({
      userId: "user-1",
      message: "Show my experience graph.",
    })).resolves.toMatchObject({
      intent: "show_experience_graph",
    });
  });

  it("repairs invalid JSON once", async () => {
    const { agent, provider } = createAgent({
      responses: ["not json", decision("explain_evidence_chain")],
    });

    await expect(agent.decide({
      userId: "user-1",
      message: "Why is this bullet supported?",
    })).resolves.toMatchObject({
      intent: "explain_evidence_chain",
    });
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.messages.at(-1)?.content).toContain("Convert the following invalid");
  });

  it("falls back when invalid JSON repair fails", async () => {
    const { agent } = createAgent({
      responses: ["not json", "still not json"],
    });

    await expect(agent.decide({
      userId: "user-1",
      message: "hello",
    })).resolves.toMatchObject({
      intent: "unknown",
      confidence: 0,
      summary: "FrontDeskAgent could not parse model output.",
    });
  });

  it("throws when fallback is disabled", async () => {
    const { agent } = createAgent({
      responses: ["not json", "still not json"],
      allowFallbackDecision: false,
    });

    await expect(agent.decide({
      userId: "user-1",
      message: "hello",
    })).rejects.toThrow();
  });

  it("passes document context to the model for document import decisions", async () => {
    const { agent, provider } = createAgent({
      responses: [decision("ingest_resume_document")],
    });

    await agent.decide({
      userId: "user-1",
      message: "I uploaded my resume. Please import it.",
      hasDocument: true,
      documentFileNames: ["resume.pdf"],
    });

    const userPrompt = provider.requests[0]?.messages.at(-1)?.content;
    expect(userPrompt).toContain("Has document: yes");
    expect(userPrompt).toContain("Document file names: resume.pdf");
  });
});
