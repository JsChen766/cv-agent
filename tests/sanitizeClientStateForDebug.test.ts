import { describe, expect, it } from "vitest";
import { sanitizeClientStateForDebug } from "../src/copilot/sanitizeClientStateForDebug.js";

describe("sanitizeClientStateForDebug", () => {
  it("truncates selectedText and keeps selectedTextLength", () => {
    const selectedText = "a".repeat(350);

    expect(sanitizeClientStateForDebug({
      mainMode: "resume_editor",
      selectedText,
    })).toEqual({
      mainMode: "resume_editor",
      selectedText: "a".repeat(300),
      selectedTextLength: 350,
    });
  });

  it("omits undefined and non-whitelisted sensitive fields", () => {
    expect(sanitizeClientStateForDebug({
      mainMode: undefined,
      activeJDId: "jd-123",
      authorization: "Bearer secret",
      cookie: "sid=secret",
      requestHeaders: { authorization: "Bearer secret" },
      customLongText: "x".repeat(1_000),
    })).toEqual({
      activeJDId: "jd-123",
    });
  });

  it("returns an empty object when clientState is not provided", () => {
    expect(sanitizeClientStateForDebug(undefined)).toEqual({});
  });
});
