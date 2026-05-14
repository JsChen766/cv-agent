import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekProvider } from "../src/providers/DeepSeekProvider.js";

describe("DeepSeekProvider request serialization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sanitizes assistant tool_calls while preserving tool_call_id and reasoning_content", async () => {
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
    expect(body.messages[1].tool_call_id).toBe("call-1");
  });
});
