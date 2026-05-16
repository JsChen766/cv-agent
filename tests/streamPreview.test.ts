import { describe, expect, it } from "vitest";
import type { LLMChatRequest, LLMChatResponse, LLMStreamChunk } from "../src/core/model/types.js";
import type { LLMProvider } from "../src/core/model/LLMProvider.js";
import { ModelClient } from "../src/core/model/ModelClient.js";
import { collectStreamPreview } from "../src/core/model/streamPreview.js";

describe("collectStreamPreview", () => {
  it("collects streamed content deltas", async () => {
    const client = createStreamingClient([
      { contentDelta: "Hello " },
      { contentDelta: "world." },
    ]);

    const result = await collectStreamPreview({
      modelClient: client,
      request: {
        messages: [{ role: "user", content: "Say hello." }],
      },
    });

    expect(result).toEqual({
      content: "Hello world.",
      truncated: false,
    });
  });

  it("does not return reasoning preview by default", async () => {
    const seenDeltas: Array<{ contentDelta?: string; reasoningDelta?: string }> = [];
    const client = createStreamingClient([
      { contentDelta: "Public answer.", reasoningDelta: "Hidden reasoning." },
    ]);

    const result = await collectStreamPreview({
      modelClient: client,
      request: {
        messages: [{ role: "user", content: "Answer." }],
      },
      onDelta: (delta) => {
        seenDeltas.push(delta);
      },
    });

    expect(result.reasoningPreview).toBeUndefined();
    expect(seenDeltas).toEqual([{ contentDelta: "Public answer." }]);
  });

  it("returns reasoning preview only when requested", async () => {
    const seenDeltas: Array<{ contentDelta?: string; reasoningDelta?: string }> = [];
    const client = createStreamingClient([
      { contentDelta: "Answer.", reasoningDelta: "Reasoning summary." },
    ]);

    const result = await collectStreamPreview({
      modelClient: client,
      request: {
        messages: [{ role: "user", content: "Answer." }],
      },
      includeReasoning: true,
      onDelta: (delta) => {
        seenDeltas.push(delta);
      },
    });

    expect(result.reasoningPreview).toBe("Reasoning summary.");
    expect(seenDeltas).toEqual([{
      contentDelta: "Answer.",
      reasoningDelta: "Reasoning summary.",
    }]);
  });

  it("truncates preview while continuing to consume the stream", async () => {
    const seenDeltas: string[] = [];
    const client = createStreamingClient([
      { contentDelta: "12345" },
      { contentDelta: "67890" },
      { contentDelta: "abc" },
    ]);

    const result = await collectStreamPreview({
      modelClient: client,
      request: {
        messages: [{ role: "user", content: "Count." }],
      },
      maxPreviewChars: 7,
      onDelta: (delta) => {
        if (delta.contentDelta) {
          seenDeltas.push(delta.contentDelta);
        }
      },
    });

    expect(result).toEqual({
      content: "1234567",
      truncated: true,
    });
    expect(seenDeltas).toEqual(["12345", "67890", "abc"]);
  });
});

function createStreamingClient(chunks: LLMStreamChunk[]): ModelClient {
  return new ModelClient({
    provider: new FakeStreamingProvider(chunks),
    defaultModel: "fake-model",
  });
}

class FakeStreamingProvider implements LLMProvider {
  public readonly name = "fake-stream";

  public constructor(private readonly chunks: LLMStreamChunk[]) {}

  public async chat(_request: LLMChatRequest): Promise<LLMChatResponse> {
    return {
      content: "",
    };
  }

  public async *stream(_request: LLMChatRequest): AsyncIterable<LLMStreamChunk> {
    for (const chunk of this.chunks) {
      yield chunk;
    }
  }
}
