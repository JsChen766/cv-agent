import { describe, expect, it } from "vitest";
import type { ToolCall } from "../src/core/tool/types.js";
import { normalizeOpenAIChatResponse, toOpenAIRequestToolCalls } from "../src/providers/providerUtils.js";

describe("normalizeOpenAIChatResponse", () => {
  it("parses tool_calls when assistant content is empty", () => {
    const raw = {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "echo",
                  arguments: "{\"message\":\"hello\"}"
                }
              }
            ]
          }
        }
      ]
    };

    const response = normalizeOpenAIChatResponse(raw);

    expect(response.content).toBe("");
    expect(response.toolCalls).toEqual([
      {
        id: "call-1",
        type: "function",
        function: {
          name: "echo",
          arguments: "{\"message\":\"hello\"}"
        },
        raw: raw.choices[0].message.tool_calls[0]
      }
    ]);
  });

  it("keeps raw on normalized ToolCall for internal debugging", () => {
    const raw = {
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "echo",
                  arguments: "{\"message\":\"hello\"}"
                },
                extra_provider_field: "debug"
              }
            ]
          }
        }
      ]
    };

    const response = normalizeOpenAIChatResponse(raw);

    expect(response.toolCalls?.[0].raw).toBe(raw.choices[0].message.tool_calls[0]);
  });
});

describe("toOpenAIRequestToolCalls", () => {
  it("removes raw and provider-specific fields from request tool_calls", () => {
    const toolCalls: ToolCall[] = [
      {
        id: "call-1",
        type: "function",
        function: {
          name: "echo",
          arguments: JSON.stringify({ message: "hello" })
        },
        raw: { providerSpecific: true }
      }
    ];

    const result = toOpenAIRequestToolCalls(toolCalls);

    expect(result).toEqual([
      {
        id: "call-1",
        type: "function",
        function: {
          name: "echo",
          arguments: "{\"message\":\"hello\"}"
        }
      }
    ]);
    expect(JSON.stringify(result)).not.toContain("raw");
    expect(JSON.stringify(result)).not.toContain("providerSpecific");
  });
});
