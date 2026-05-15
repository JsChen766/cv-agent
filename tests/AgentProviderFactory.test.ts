import { describe, expect, it } from "vitest";
import {
  AgentProviderFactory,
  readAgentModeConfig,
  type AgentProviderFactoryConfig,
} from "../src/providers/factory/index.js";

describe("AgentProviderFactory", () => {
  it("defaults non-production env to mock", () => {
    const config = AgentProviderFactory.fromEnv({
      NODE_ENV: "test",
    });
    const result = AgentProviderFactory.create(config);

    expect(config.provider).toBe("mock");
    expect(result.providerName).toBe("mock");
    expect(result.model).toBe("mock");
    expect(result.modelClient.getProviderName()).toBe("mock");
    expect(result.warnings).toEqual([]);
  });

  it("creates MockProvider when AGENT_PROVIDER=mock", () => {
    const result = AgentProviderFactory.create({
      provider: "mock",
      timeoutMs: 5_000,
      maxRetries: 1,
    });

    expect(result.providerName).toBe("mock");
    expect(result.modelClient.getProviderName()).toBe("mock");
  });

  it("creates DeepSeekProvider when AGENT_PROVIDER=deepseek and api key exists", () => {
    const result = AgentProviderFactory.create({
      provider: "deepseek",
      apiKey: "test-key",
      model: "deepseek-test",
      allowMockFallback: false,
    });

    expect(result.providerName).toBe("deepseek");
    expect(result.model).toBe("deepseek-test");
    expect(result.modelClient.getProviderName()).toBe("deepseek");
    expect(result.warnings).toEqual([]);
  });

  it("falls back to MockProvider when DeepSeek key is missing and fallback is enabled", () => {
    const result = AgentProviderFactory.create({
      provider: "deepseek",
      allowMockFallback: true,
    });

    expect(result.providerName).toBe("mock");
    expect(result.modelClient.getProviderName()).toBe("mock");
    expect(result.warnings).toEqual([
      "DEEPSEEK_API_KEY is missing. Falling back to MockProvider because allowMockFallback is enabled.",
    ]);
  });

  it("throws when DeepSeek key is missing and fallback is disabled", () => {
    expect(() => AgentProviderFactory.create({
      provider: "deepseek",
      allowMockFallback: false,
    })).toThrow("DEEPSEEK_API_KEY is required when AGENT_PROVIDER=deepseek.");
  });

  it("defaults production env to deepseek and requires an api key", () => {
    const config = AgentProviderFactory.fromEnv({
      NODE_ENV: "production",
    });

    expect(config.provider).toBe("deepseek");
    expect(config.allowMockFallback).toBe(false);
    expect(() => AgentProviderFactory.create(config)).toThrow(
      "DEEPSEEK_API_KEY is required when AGENT_PROVIDER=deepseek.",
    );
  });

  it("rejects invalid AGENT_PROVIDER", () => {
    expect(() => AgentProviderFactory.fromEnv({
      AGENT_PROVIDER: "other",
    })).toThrow('Unknown AGENT_PROVIDER "other". Supported values are mock and deepseek.');
  });

  it("parses timeout and retry env values", () => {
    const config = AgentProviderFactory.fromEnv({
      AGENT_PROVIDER: "mock",
      AGENT_TIMEOUT_MS: "1234",
      AGENT_MAX_RETRIES: "2",
      ALLOW_MOCK_FALLBACK: "0",
    });

    expect(config.timeoutMs).toBe(1234);
    expect(config.maxRetries).toBe(2);
    expect(config.allowMockFallback).toBe(false);
  });

  it("rejects invalid numeric env values clearly", () => {
    expect(() => AgentProviderFactory.fromEnv({
      AGENT_TIMEOUT_MS: "abc",
    })).toThrow("AGENT_TIMEOUT_MS must be a non-negative number.");

    expect(() => AgentProviderFactory.fromEnv({
      AGENT_MAX_RETRIES: "-1",
    })).toThrow("AGENT_MAX_RETRIES must be a non-negative number.");
  });

  it("rejects unknown provider config defensively", () => {
    const config = {
      provider: "invalid",
    } as unknown as AgentProviderFactoryConfig;

    expect(() => AgentProviderFactory.create(config)).toThrow(
      'Unknown AGENT_PROVIDER "invalid". Supported values are mock and deepseek.',
    );
  });
});

describe("readAgentModeConfig", () => {
  it("returns deterministic defaults for future LLM-backed modes", () => {
    expect(readAgentModeConfig({})).toEqual({
      frontDeskAgentMode: "mock",
      experienceExtractorMode: "deterministic",
      artifactGeneratorMode: "deterministic",
      criticAgentMode: "deterministic",
    });
  });

  it("reads configured agent modes", () => {
    expect(readAgentModeConfig({
      FRONTDESK_AGENT_MODE: "llm",
      EXPERIENCE_EXTRACTOR_MODE: "llm",
      ARTIFACT_GENERATOR_MODE: "llm",
      CRITIC_AGENT_MODE: "llm",
    })).toEqual({
      frontDeskAgentMode: "llm",
      experienceExtractorMode: "llm",
      artifactGeneratorMode: "llm",
      criticAgentMode: "llm",
    });
  });

  it("rejects invalid agent mode values", () => {
    expect(() => readAgentModeConfig({
      FRONTDESK_AGENT_MODE: "deterministic",
    })).toThrow("FRONTDESK_AGENT_MODE must be one of: mock, llm.");
  });
});
