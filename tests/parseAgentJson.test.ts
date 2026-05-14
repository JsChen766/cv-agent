import { describe, expect, it } from "vitest";
import { JsonParseError, parseAgentJson } from "../src/core/json/index.js";

describe("parseAgentJson", () => {
  it("parses pure JSON object", () => {
    expect(parseAgentJson('{"ok":true}', { expectedRoot: "object" })).toEqual({ ok: true });
  });

  it("parses pure JSON array", () => {
    expect(parseAgentJson('[{"ok":true}]', { expectedRoot: "array" })).toEqual([{ ok: true }]);
  });

  it("parses json code fence", () => {
    const raw = [
      "```json",
      '{"ok":true}',
      "```",
    ].join("\n");

    expect(parseAgentJson(raw, { expectedRoot: "object" })).toEqual({ ok: true });
  });

  it("parses JSON after leading text", () => {
    const raw = 'Here is the JSON: {"ok":true}';

    expect(parseAgentJson(raw, { expectedRoot: "object" })).toEqual({ ok: true });
  });

  it("parses JSON before trailing text", () => {
    const raw = '{"ok":true}\nThis is the extracted object.';

    expect(parseAgentJson(raw, { expectedRoot: "object" })).toEqual({ ok: true });
  });

  it("parses nested object and array", () => {
    const raw = 'Result: {"items":[{"name":"React","meta":{"weight":1}}]}';

    expect(parseAgentJson(raw, { expectedRoot: "object" })).toEqual({
      items: [{ name: "React", meta: { weight: 1 } }],
    });
  });

  it("does not truncate when strings contain braces", () => {
    const raw = 'Here is the JSON: {"text":"Use {placeholder} safely","items":[{"value":"}"}]} done';

    expect(parseAgentJson(raw, { expectedRoot: "object" })).toEqual({
      text: "Use {placeholder} safely",
      items: [{ value: "}" }],
    });
  });

  it("throws when object root is expected but array is returned", () => {
    expect(() => parseAgentJson("[]", { expectedRoot: "object" })).toThrow(JsonParseError);
  });

  it("throws when array root is expected but object is returned", () => {
    expect(() => parseAgentJson("{}", { expectedRoot: "array" })).toThrow(JsonParseError);
  });

  it("throws JsonParseError on invalid JSON", () => {
    expect(() => parseAgentJson("not json at all")).toThrow(JsonParseError);
  });
});
