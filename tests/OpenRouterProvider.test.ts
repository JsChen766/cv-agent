import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenRouterProvider } from "../src/providers/OpenRouterProvider.js";

describe("OpenRouterProvider request serialization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("OpenRouterProvider request body does not include raw", async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: "ok"
            }
          }
        ]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    const provider = new OpenRouterProvider({
      apiKey: "test-key",
      baseURL: "https://example.test"
    });

    await provider.chat({
      model: "openrouter-test",
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "echo",
                arguments: "{\"message\":\"hello\"}"
              },
              raw: { shouldNotLeak: true }
            }
          ]
        }
      ]
    });

    const body = requestBody as { messages: Array<Record<string, unknown>> };

    expect(body.messages[0].tool_calls).toEqual([
      {
        id: "call-1",
        type: "function",
        function: {
          name: "echo",
          arguments: "{\"message\":\"hello\"}"
        }
      }
    ]);
    expect(JSON.stringify(body.messages[0].tool_calls)).not.toContain("raw");
    expect(JSON.stringify(body.messages[0].tool_calls)).not.toContain("shouldNotLeak");
  });

  it("OpenRouterProvider request body should not include message.metadata", async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: "ok"
            }
          }
        ]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    const provider = new OpenRouterProvider({
      apiKey: "test-key",
      baseURL: "https://example.test"
    });

    await provider.chat({
      model: "openrouter-test",
      messages: [
        {
          role: "user",
          content: "hello",
          metadata: {
            internalTraceId: "trace-1",
            documentId: "doc-1"
          }
        }
      ]
    });

    const body = requestBody as { messages: Array<Record<string, unknown>> };

    expect(JSON.stringify(body)).not.toContain("internalTraceId");
    expect(JSON.stringify(body)).not.toContain("documentId");
    expect(body.messages[0].metadata).toBeUndefined();
  });
});
