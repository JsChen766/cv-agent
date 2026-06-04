import { describe, expect, it } from "vitest";
import { AgentError } from "../src/agent-core/runtime/AgentError.js";
import { parseAgentJson } from "../src/agent-core/validation/parseAgentJson.js";

describe("parseAgentJson", () => {
  it("parses valid JSON", () => {
    expect(parseAgentJson(`{"responseType":"final","assistantMessage":"ok"}`)).toEqual({
      responseType: "final",
      assistantMessage: "ok",
    });
  });

  it("parses fenced JSON", () => {
    expect(parseAgentJson("```json\n{\"responseType\":\"final\",\"assistantMessage\":\"ok\"}\n```")).toEqual({
      responseType: "final",
      assistantMessage: "ok",
    });
  });

  it("throws AgentError with INVALID_AGENT_OUTPUT for invalid JSON", () => {
    expect(() => parseAgentJson("{bad json")).toThrow(AgentError);
    try {
      parseAgentJson("{bad json");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentError);
      expect((error as AgentError).code).toBe("INVALID_AGENT_OUTPUT");
      expect((error as Error).message).toBe("Agent returned invalid JSON.");
    }
  });

  it("throws AgentError with INVALID_AGENT_OUTPUT when no JSON is present", () => {
    expect(() => parseAgentJson("plain text only")).toThrow(AgentError);
    try {
      parseAgentJson("plain text only");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentError);
      expect((error as AgentError).code).toBe("INVALID_AGENT_OUTPUT");
    }
  });
});
