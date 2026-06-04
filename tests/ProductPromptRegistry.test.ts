import { describe, expect, it } from "vitest";
import { ModelClient } from "../src/agent-core/model/ModelClient.js";
import type { LLMChatRequest, LLMProvider } from "../src/agent-core/model/types.js";
import { PromptRegistry } from "../src/agent-core/prompts/PromptRegistry.js";
import { LLMExperienceExtractor } from "../src/product/LLMExperienceExtractor.js";

describe("Product prompts in PromptRegistry", () => {
  it("loads the migrated product experience extraction prompts", () => {
    const registry = new PromptRegistry();

    const systemPrompt = registry.get("product.experienceExtraction.system");
    const repairPrompt = registry.get("product.experienceExtraction.repair");

    expect(systemPrompt).toContain("You are a professional resume parser.");
    expect(systemPrompt).toContain("Output ONLY valid JSON. No markdown, no explanation.");
    expect(systemPrompt.endsWith("No markdown, no explanation.")).toBe(true);
    expect(repairPrompt).toContain("Errors: {{errors}}");
    expect(repairPrompt).toContain("Output ONLY the corrected JSON.");
  });

  it("throws a clear error for an unregistered prompt key", () => {
    const registry = new PromptRegistry();

    expect(() => registry.get("product.missing" as any)).toThrow("Prompt not registered: product.missing");
  });

  it("uses the migrated prompt when constructing the experience extraction request", async () => {
    const registry = new PromptRegistry();
    let capturedRequest: LLMChatRequest | undefined;
    const provider: LLMProvider = {
      name: "fake",
      async chat(request) {
        capturedRequest = request;
        return {
          content: JSON.stringify({
            candidates: [
              {
                type: "work",
                title: "Frontend Engineer",
                content: "Built a dashboard for operations reporting.",
              },
            ],
          }),
        };
      },
    };

    const extractor = new LLMExperienceExtractor(new ModelClient({ provider, defaultModel: "fake", maxRetries: 0 }));
    const candidates = await extractor.extractCandidates("Built a dashboard for operations reporting.");

    expect(candidates).toHaveLength(1);
    expect(capturedRequest?.messages[0]?.role).toBe("system");
    expect(capturedRequest?.messages[0]?.content).toBe(registry.get("product.experienceExtraction.system"));
  });
});
