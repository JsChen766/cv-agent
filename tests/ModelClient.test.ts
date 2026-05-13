import { describe, expect, it } from "vitest";
import { ModelClient } from "../src/core/model/ModelClient.js";
import { MockProvider } from "../src/providers/MockProvider.js";

describe("ModelClient", () => {
  it("returns a response with MockProvider", async () => {
    const client = new ModelClient({
      provider: new MockProvider(),
      defaultModel: "mock-model"
    });

    const response = await client.chat({
      messages: [{ role: "user", content: "hello" }]
    });

    expect(response.content).toContain("hello");
    expect(response.usage?.totalTokens).toBeGreaterThan(0);
  });

  it("can switch providers", () => {
    const client = new ModelClient({
      provider: new MockProvider(),
      defaultModel: "mock-model"
    });

    client.setProvider(new MockProvider());

    expect(client.getProviderName()).toBe("mock");
  });
});
