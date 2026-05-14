import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekProvider } from "../src/providers/DeepSeekProvider.js";

describe("DeepSeekProvider request serialization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("DeepSeekProvider request body does not include raw", async () => {
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

    const provider = new DeepSeekProvider({
      apiKey: "test-key",
      baseURL: "https://example.test"
    });

    await provider.chat({
      model: "deepseek-test",
      messages: [
        {
          role: "assistant",
          content: "",
          reasoningContent: "Need to use echo.",
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
        },
        {
          role: "tool",
          toolCallId: "call-1",
          content: "{\"ok\":true}"
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
    expect(body.messages[0].reasoning_content).toBe("Need to use echo.");
  });

  it("tool role message still serializes tool_call_id", async () => {
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

    const provider = new DeepSeekProvider({
      apiKey: "test-key",
      baseURL: "https://example.test"
    });

    await provider.chat({
      model: "deepseek-test",
      messages: [
        {
          role: "tool",
          toolCallId: "call-1",
          content: "{\"ok\":true}"
        }
      ]
    });

    const body = requestBody as { messages: Array<Record<string, unknown>> };

    expect(body.messages[0]).toMatchObject({
      role: "tool",
      content: "{\"ok\":true}",
      tool_call_id: "call-1"
    });
  });
});
