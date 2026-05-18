import { afterEach, describe, expect, it } from "vitest";
import { createKernel } from "../src/api/kernel/createKernel.js";

const ORIGINAL_ENV = { ...process.env };

describe("Agent runtime guards", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("rejects deterministic kernel modes in development unless explicitly allowed", async () => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: "development",
      AUTH_MODE: "dev_header",
      AGENT_PROVIDER: "deepseek",
      AGENT_API_KEY: "test-key",
      FRONTDESK_AGENT_MODE: "llm",
      ARTIFACT_GENERATOR_MODE: "deterministic",
    };
    delete process.env.ALLOW_DETERMINISTIC_RUNTIME;
    delete process.env.DATABASE_URL;

    await expect(createKernel()).rejects.toThrow("Deterministic kernel agent mode is not allowed");
  });

  it("allows deterministic kernel modes in development when explicitly enabled and reports a warning", async () => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: "development",
      AUTH_MODE: "dev_header",
      AGENT_PROVIDER: "deepseek",
      AGENT_API_KEY: "test-key",
      FRONTDESK_AGENT_MODE: "llm",
      ALLOW_DETERMINISTIC_RUNTIME: "true",
      EXPERIENCE_EXTRACTOR_MODE: "deterministic",
      ARTIFACT_GENERATOR_MODE: "deterministic",
      CRITIC_AGENT_MODE: "deterministic",
      REVISION_AGENT_MODE: "deterministic",
    };
    delete process.env.DATABASE_URL;

    const kernel = await createKernel();
    expect(kernel.warnings).toContain("Deterministic runtime is enabled. This should not be used for product-quality LLM behavior.");
    await kernel.close();
  });

  it("allows deterministic kernel modes in test", async () => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: "test",
      AUTH_MODE: "dev_header",
      AGENT_PROVIDER: "mock",
      FRONTDESK_AGENT_MODE: "fake",
      EXPERIENCE_EXTRACTOR_MODE: "deterministic",
      ARTIFACT_GENERATOR_MODE: "deterministic",
      CRITIC_AGENT_MODE: "deterministic",
      REVISION_AGENT_MODE: "deterministic",
    };
    delete process.env.DATABASE_URL;

    const kernel = await createKernel();
    expect(kernel.mode).toBe("in_memory");
    await kernel.close();
  });

  it("rejects mock runtime in development unless explicitly allowed", async () => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: "development",
      AUTH_MODE: "dev_header",
      AGENT_PROVIDER: "mock",
      FRONTDESK_AGENT_MODE: "llm",
      EXPERIENCE_EXTRACTOR_MODE: "llm",
      ARTIFACT_GENERATOR_MODE: "llm",
      CRITIC_AGENT_MODE: "llm",
      REVISION_AGENT_MODE: "llm",
    };
    delete process.env.ALLOW_MOCK_RUNTIME;
    delete process.env.DATABASE_URL;

    await expect(createKernel()).rejects.toThrow("MockProvider is only allowed");
  });
});
