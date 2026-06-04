import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  parseJsonArray,
  parseJsonObject,
  previewContent,
  safeParseJsonOutput,
} from "../src/infrastructure/llm/JsonOutputParser.js";

describe("JsonOutputParser", () => {
  it("parses a raw object", () => {
    expect(parseJsonObject(`{"a":1}`)).toEqual({ a: 1 });
  });

  it("parses a raw array", () => {
    expect(parseJsonArray<number>(`[1,2,3]`)).toEqual([1, 2, 3]);
  });

  it("parses a json fenced block", () => {
    expect(parseJsonObject("```json\n{\"a\":1}\n```")).toEqual({ a: 1 });
  });

  it("parses a plain fenced block", () => {
    expect(parseJsonObject("```\n{\"a\":1}\n```")).toEqual({ a: 1 });
  });

  it("extracts an object from explanatory text", () => {
    expect(parseJsonObject("Sure, here is the JSON:\n{\"a\":{\"b\":2}}\nDone.")).toEqual({ a: { b: 2 } });
  });

  it("extracts an array from explanatory text", () => {
    expect(parseJsonArray<{ id: string }>("Result:\n[{\"id\":\"one\"},{\"id\":\"two\"}]\nDone.")).toEqual([
      { id: "one" },
      { id: "two" },
    ]);
  });

  it("returns EMPTY_OUTPUT for empty content", () => {
    const result = safeParseJsonOutput("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("EMPTY_OUTPUT");
  });

  it("returns NO_JSON_FOUND when no JSON is present", () => {
    const result = safeParseJsonOutput("plain explanatory text only");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NO_JSON_FOUND");
  });

  it("returns INVALID_JSON for malformed JSON-like content", () => {
    const result = safeParseJsonOutput("{bad json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_JSON");
  });

  it("returns EXPECTED_TYPE_MISMATCH when object is expected but array is returned", () => {
    const result = safeParseJsonOutput("[1,2]", { expected: "object" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("EXPECTED_TYPE_MISMATCH");
  });

  it("returns EXPECTED_TYPE_MISMATCH when array is expected but object is returned", () => {
    const result = safeParseJsonOutput("{\"a\":1}", { expected: "array" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("EXPECTED_TYPE_MISMATCH");
  });

  it("validates parsed JSON against a schema", () => {
    const schema = z.object({ a: z.number() });
    const result = safeParseJsonOutput("{\"a\":1}", { expected: "object", schema });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ a: 1 });
  });

  it("returns SCHEMA_VALIDATION_FAILED for schema mismatch", () => {
    const schema = z.object({ a: z.number() });
    const result = safeParseJsonOutput("{\"a\":\"wrong\"}", { expected: "object", schema });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SCHEMA_VALIDATION_FAILED");
  });

  it("truncates previews", () => {
    const preview = previewContent("x".repeat(240), 20);
    expect(preview).toBe(`${"x".repeat(20)}...`);
  });
});
