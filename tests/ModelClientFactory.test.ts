import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ModelClientFactory, maskApiKey, debugModelConfig, describeModelConfig } from "../src/providers/ModelClientFactory.js";
import type { ModelClientFactoryEnv } from "../src/providers/ModelClientFactory.js";
import type { ResolvedUserModelConfig } from "../src/auth/types.js";

function fakeEnv(overrides: Partial<ModelClientFactoryEnv> = {}): ModelClientFactoryEnv {
  return {
    DEEPSEEK_API_KEY: "sk-test-deepseek-key-12345678",
    ...overrides,
  };
}

describe("ModelClientFactory — default creation", () => {
  it("creates a default deepseek ModelClient when env has DEEPSEEK_API_KEY", () => {
    const factory = new ModelClientFactory(fakeEnv());
    const result = factory.createDefaultModelClient();

    expect(result.client).toBeDefined();
    expect(result.warnings).toHaveLength(0);
    expect(result.config.provider).toBe("deepseek");
    expect(result.config.model).toBe("deepseek-chat");
    expect(result.config.apiKeyConfigured).toBe(true);
    // apiKey must be masked, never exposed
    expect(result.config.apiKeyMasked).toBeDefined();
    expect(result.config.apiKeyMasked).not.toContain("sk-test-deepseek-key-12345678");
    expect(result.config.apiKeyMasked).toMatch(/^sk-t.*5678$/);
  });

  it("returns no client and a warning when DEEPSEEK_API_KEY is missing", () => {
    const factory = new ModelClientFactory(fakeEnv({ DEEPSEEK_API_KEY: undefined }));
    const result = factory.createDefaultModelClient();

    expect(result.client).toBeUndefined();
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("DEEPSEEK_API_KEY");
    expect(result.config.apiKeyConfigured).toBe(false);
  });

  it("creates an openai ModelClient when AGENT_MODEL_PROVIDER is openai", () => {
    const factory = new ModelClientFactory(fakeEnv({
      AGENT_MODEL_PROVIDER: "openai",
      DEEPSEEK_API_KEY: undefined,
      OPENAI_API_KEY: "sk-openai-test-key",
    }));
    const result = factory.createDefaultModelClient();

    expect(result.client).toBeDefined();
    expect(result.warnings).toHaveLength(0);
    expect(result.config.provider).toBe("openai");
    expect(result.config.apiKeyConfigured).toBe(true);
    expect(result.config.apiKeyMasked).not.toContain("sk-openai-test-key");
  });

  it("returns no client when openai provider has no key", () => {
    const factory = new ModelClientFactory(fakeEnv({
      AGENT_MODEL_PROVIDER: "openai",
      DEEPSEEK_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
    }));
    const result = factory.createDefaultModelClient();

    expect(result.client).toBeUndefined();
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.config.apiKeyConfigured).toBe(false);
  });

  it("supports AGENT_MODEL_API_KEY as fallback for deepseek", () => {
    const factory = new ModelClientFactory(fakeEnv({
      DEEPSEEK_API_KEY: undefined,
      AGENT_MODEL_API_KEY: "sk-fallback-key",
    }));
    const result = factory.createDefaultModelClient();

    expect(result.client).toBeDefined();
    expect(result.config.apiKeyConfigured).toBe(true);
    expect(result.config.apiKeyMasked).not.toContain("sk-fallback-key");
  });
});

describe("ModelClientFactory — user-scoped creation", () => {
  it("creates a client from user deepseek config", () => {
    const factory = new ModelClientFactory(fakeEnv({ DEEPSEEK_API_KEY: undefined }));
    const userConfig: ResolvedUserModelConfig = {
      provider: "deepseek",
      apiKey: "sk-user-deepseek-key",
      model: "deepseek-v4-pro",
    };
    const result = factory.createModelClientForUser(userConfig);

    expect(result.client).toBeDefined();
    expect(result.warnings).toHaveLength(0);
    expect(result.config.provider).toBe("deepseek");
    expect(result.config.model).toBe("deepseek-v4-pro");
    expect(result.config.apiKeyConfigured).toBe(true);
    expect(result.config.apiKeyMasked).not.toContain("sk-user-deepseek-key");
  });

  it("creates a client from user openai config", () => {
    const factory = new ModelClientFactory(fakeEnv({ DEEPSEEK_API_KEY: undefined }));
    const userConfig: ResolvedUserModelConfig = {
      provider: "openai",
      apiKey: "sk-user-openai-key",
      model: "gpt-4o",
    };
    const result = factory.createModelClientForUser(userConfig);

    expect(result.client).toBeDefined();
    expect(result.config.provider).toBe("openai");
    expect(result.config.model).toBe("gpt-4o");
    expect(result.config.apiKeyConfigured).toBe(true);
  });

  it("falls back to default when user config is incomplete", () => {
    const factory = new ModelClientFactory(fakeEnv());
    const userConfig: ResolvedUserModelConfig = {}; // no provider or apiKey
    const result = factory.createModelClientForUser(userConfig);

    // Should fall back to default (deepseek from fakeEnv)
    expect(result.client).toBeDefined();
    expect(result.config.provider).toBe("deepseek");
    expect(result.warnings.some((w) => w.includes("system default"))).toBe(true);
  });

  it("falls back to default when user config has provider but no apiKey", () => {
    const factory = new ModelClientFactory(fakeEnv());
    const userConfig: ResolvedUserModelConfig = { provider: "deepseek" }; // no apiKey
    const result = factory.createModelClientForUser(userConfig);

    expect(result.client).toBeDefined();
    expect(result.warnings.some((w) => w.includes("system default"))).toBe(true);
  });

  it("returns a warning for an unknown user provider", () => {
    const factory = new ModelClientFactory(fakeEnv({ DEEPSEEK_API_KEY: undefined }));
    const userConfig: ResolvedUserModelConfig = {
      provider: "unknown_provider" as ResolvedUserModelConfig["provider"],
      apiKey: "some-key",
    };
    const result = factory.createModelClientForUser(userConfig);

    expect(result.client).toBeUndefined();
    expect(result.config.apiKeyConfigured).toBe(false);
    expect(result.warnings.some((w) => w.includes("Unknown provider"))).toBe(true);
  });
});

describe("maskApiKey", () => {
  it("masks a normal-length key", () => {
    const masked = maskApiKey("sk-1234567890abcdef");
    expect(masked).toBe("sk-1...cdef");
  });

  it("returns **** for short keys", () => {
    expect(maskApiKey("short")).toBe("****");
    expect(maskApiKey("12345678")).toBe("****");
  });

  it("never returns the original key", () => {
    const key = "sk-abcdefghijklmnop";
    expect(maskApiKey(key)).not.toBe(key);
  });
});

describe("debugModelConfig", () => {
  it("does not throw", () => {
    expect(() => debugModelConfig({
      provider: "deepseek",
      model: "deepseek-chat",
      apiKeyConfigured: true,
      apiKeyMasked: "sk-t...5678",
    })).not.toThrow();
  });
});

describe("describeModelConfig", () => {
  it("returns a safe string without exposing full apiKey", () => {
    const summary = describeModelConfig({
      provider: "deepseek",
      model: "deepseek-chat",
      baseURL: "https://api.deepseek.com",
      apiKeyConfigured: true,
      apiKeyMasked: "sk-t...5678",
    });
    expect(summary).toContain("provider=deepseek");
    expect(summary).toContain("model=deepseek-chat");
    expect(summary).toContain("baseURL=https://api.deepseek.com");
    expect(summary).toContain("apiKey=sk-t...5678");
    // Must NOT contain a full key
    expect(summary).not.toMatch(/sk-[a-zA-Z0-9]{20,}/);
  });

  it("shows 'missing' when apiKey is not configured", () => {
    const summary = describeModelConfig({
      provider: "openai",
      model: "gpt-4o",
      apiKeyConfigured: false,
    });
    expect(summary).toContain("apiKey=missing");
  });

  it("shows 'default' when baseURL is not set", () => {
    const summary = describeModelConfig({
      provider: "deepseek",
      model: "deepseek-chat",
      apiKeyConfigured: true,
      apiKeyMasked: "sk-t...5678",
    });
    expect(summary).toContain("baseURL=default");
  });
});

describe(".env.example safety", () => {
  const example = readFileSync(".env.example", "utf8");

  it("does not contain a real-looking API key", () => {
    expect(example).not.toMatch(/sk-[a-zA-Z0-9]{20,}/);
    expect(example).not.toMatch(/Bearer [a-zA-Z0-9_-]{20,}/);
  });

  it("contains AGENT_MODEL_PROVIDER field", () => {
    expect(example).toContain("AGENT_MODEL_PROVIDER");
  });

  it("does not contain openrouter as a supported provider", () => {
    const lines = example.split("\n");
    const activeLines = lines.filter((l) => !l.trim().startsWith("#") && l.includes("OPENROUTER"));
    expect(activeLines).toHaveLength(0);
  });

  it("does not contain DEFAULT_PROVIDER as active config", () => {
    const lines = example.split("\n");
    const activeLines = lines.filter((l) => {
      const trimmed = l.trim();
      return trimmed.startsWith("DEFAULT_PROVIDER") || trimmed.startsWith("DEFAULT_MODEL");
    });
    expect(activeLines).toHaveLength(0);
  });
});
