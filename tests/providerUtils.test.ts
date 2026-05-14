import { describe, expect, it } from "vitest";
import { normalizeOpenAIChatResponse } from "../src/providers/providerUtils.js";

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
});
