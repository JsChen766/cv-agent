import { describe, expect, it } from "vitest";
import { ModelClient } from "../src/agent-core/model/ModelClient.js";
import type { LLMChatRequest, LLMProvider } from "../src/agent-core/model/types.js";
import { PromptRegistry } from "../src/agent-core/prompts/PromptRegistry.js";
import { LLMExperienceExtractor } from "../src/product/LLMExperienceExtractor.js";
import { LLMGenerationService } from "../src/product/LLMGenerationService.js";
import { LLMRewriteService } from "../src/product/LLMRewriteService.js";
import { createPrepareReviseResumeItemTool } from "../src/agent-tools/resume/prepareReviseResumeItem.tool.js";
import { matchExperiencesAgainstJDTool } from "../src/agent-tools/experience/matchExperiencesAgainstJD.tool.js";
import type { ProductExperienceSummary } from "../src/product/types.js";

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

describe("Rewrite prompts in PromptRegistry", () => {
  it("loads the migrated rewrite system prompts", () => {
    const registry = new PromptRegistry();

    const expSystem = registry.get("product.rewrite.experienceSystem");
    const itemSystem = registry.get("product.rewrite.resumeItemSystem");
    const claimSystem = registry.get("product.rewrite.claimCheckSystem");

    // Experience rewrite system prompt
    expect(expSystem).toContain("You are a professional resume editor.");
    expect(expSystem).toContain("STAR method");
    expect(expSystem).toContain("Output ONLY valid JSON.");

    // Resume item rewrite system prompt
    expect(itemSystem).toContain("Rewrite a single resume bullet point");
    expect(itemSystem).toContain("rewrittenText");

    // Claim check system prompt
    expect(claimSystem).toContain("You are a resume fact-checker.");
    expect(claimSystem).toContain("Output ONLY valid JSON.");
  });

  it("throws a clear error for an unregistered rewrite prompt key", () => {
    const registry = new PromptRegistry();

    expect(() => registry.get("product.rewrite.missing" as any)).toThrow(
      "Prompt not registered: product.rewrite.missing",
    );
  });

  it("LLMRewriteService constructs rewrite experience prompt from registry", async () => {
    const registry = new PromptRegistry();
    let capturedRequest: LLMChatRequest | undefined;
    const provider: LLMProvider = {
      name: "fake",
      async chat(request) {
        capturedRequest = request;
        return {
          content: JSON.stringify({
            rewrittenText: "Improved version of the experience.",
            sourceTextPreview: "Original experience text...",
            changes: [],
            warnings: [],
            confidence: 0.9,
          }),
        };
      },
    };

    const service = new LLMRewriteService(
      new ModelClient({ provider, defaultModel: "fake", maxRetries: 0 }),
    );
    await service.rewriteExperience("Built dashboard for ops team.", "Make it more impactful.");

    expect(capturedRequest?.messages[0]?.role).toBe("system");
    expect(capturedRequest?.messages[0]?.content).toBe(
      registry.get("product.rewrite.experienceSystem"),
    );
  });

  it("LLMRewriteService constructs claim check prompt from registry", async () => {
    const registry = new PromptRegistry();
    let capturedRequest: LLMChatRequest | undefined;
    const provider: LLMProvider = {
      name: "fake",
      async chat(request) {
        capturedRequest = request;
        return {
          content: JSON.stringify({
            claims: [],
            summary: { totalClaims: 0, supportedClaims: 0, unsupportedClaims: 0, riskLevel: "low" },
          }),
        };
      },
    };

    const service = new LLMRewriteService(
      new ModelClient({ provider, defaultModel: "fake", maxRetries: 0 }),
    );
    await service.checkClaims("Experienced engineer.", []);

    expect(capturedRequest?.messages[0]?.role).toBe("system");
    expect(capturedRequest?.messages[0]?.content).toBe(
      registry.get("product.rewrite.claimCheckSystem"),
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// Generation prompts in PromptRegistry
// ═══════════════════════════════════════════════════════════════

function fakeExperiencesForGen(): ProductExperienceSummary[] {
  return [
    {
      id: "exp-1",
      title: "Frontend Developer @ Acme",
      organization: "Acme",
      role: "Frontend Developer",
      startDate: "2022-01",
      endDate: "2024-01",
      category: "work",
      content: "Built React components, improved performance by 40%.",
      status: "active",
      currentRevisionId: "rev-1",
      sourceDocumentId: undefined,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ];
}

describe("Generation prompts in PromptRegistry", () => {
  it("loads the migrated generation system and repair prompts", () => {
    const registry = new PromptRegistry();

    const systemPrompt = registry.get("product.generation.resumeSystem");
    const repairPrompt = registry.get("product.generation.resumeRepair");

    // System prompt contains key instructions
    expect(systemPrompt).toContain("senior resume content strategist and professional resume writer");
    expect(systemPrompt).toContain("QUALITY BAR");
    expect(systemPrompt).toContain("Never write placeholders");
    expect(systemPrompt).toContain("ONLY use facts, metrics, and experiences that are present");
    expect(systemPrompt).toContain("sourceExperienceIds");
    expect(systemPrompt).toContain("evidenceSummary");
    expect(systemPrompt).toContain("riskSummary");
    expect(systemPrompt).toContain("missingInfo");
    expect(systemPrompt).toContain("Output ONLY valid JSON. No markdown, no explanation.");
    expect(systemPrompt.endsWith("No markdown, no explanation.")).toBe(true);

    // Repair prompt contains key instructions
    expect(repairPrompt).toContain("The previous output failed JSON schema validation.");
    expect(repairPrompt).toContain("Errors: {{errors}}");
    expect(repairPrompt).toContain("Output ONLY the corrected JSON.");
  });

  it("throws a clear error for an unregistered generation prompt key", () => {
    const registry = new PromptRegistry();

    expect(() => registry.get("product.generation.missing" as any)).toThrow(
      "Prompt not registered: product.generation.missing",
    );
  });

  it("LLMGenerationService constructs system prompt from registry", async () => {
    const registry = new PromptRegistry();
    let capturedRequest: LLMChatRequest | undefined;
    const provider: LLMProvider = {
      name: "fake",
      async chat(request: LLMChatRequest) {
        capturedRequest = request;
        return {
          content: JSON.stringify({
            variants: [{
              content: "Experienced frontend developer with React.",
              score: { overall: 0.8, relevance: 0.9, evidenceStrength: 0.7 },
              reason: "Good match.",
              sourceExperienceIds: ["exp-1"],
            }],
          }),
        };
      },
    };

    const service = new LLMGenerationService(
      new ModelClient({ provider, defaultModel: "fake", maxRetries: 0 }),
    );
    await service.generateVariants("user-1", "React developer needed.", "Frontend Engineer", fakeExperiencesForGen());

    expect(capturedRequest?.messages[0]?.role).toBe("system");
    expect(capturedRequest?.messages[0]?.content).toBe(
      registry.get("product.generation.resumeSystem"),
    );
  });

  it("LLMGenerationService repair prompt template contains {{errors}} placeholder", () => {
    const registry = new PromptRegistry();
    const repairPrompt = registry.get("product.generation.resumeRepair");

    // The repair prompt is a template with {{errors}} placeholder — verify it is present
    expect(repairPrompt).toContain("{{errors}}");
    // Verify the replacement pattern works as expected by the service
    const filled = repairPrompt.replace("{{errors}}", "some error detail");
    expect(filled).toContain("some error detail");
    expect(filled).not.toContain("{{errors}}");
  });
});

// ═══════════════════════════════════════════════════════════════
// Resume tool prompts in PromptRegistry
// ═══════════════════════════════════════════════════════════════

describe("Resume tool prompts in PromptRegistry", () => {
  it("loads the migrated resume tool prompt", () => {
    const registry = new PromptRegistry();

    const prompt = registry.get("tools.resume.prepareReviseResumeItem.system");

    expect(prompt).toContain("You are a professional resume editor.");
    expect(prompt).toContain("Rewrite a single resume bullet point based on the instruction.");
    expect(prompt).toContain("Preserve all factual claims, metrics, and numbers.");
    expect(prompt).toContain("Do NOT invent new metrics or facts.");
    expect(prompt).toContain("Output ONLY the rewritten text. No markdown, no explanation.");
    expect(prompt.endsWith("No markdown, no explanation.")).toBe(true);
  });

  it("throws a clear error for an unregistered resume tool prompt key", () => {
    const registry = new PromptRegistry();

    expect(() => registry.get("tools.resume.missing" as any)).toThrow(
      "Prompt not registered: tools.resume.missing",
    );
  });

  it("prepareReviseResumeItem tool factory returns a tool with correct id and schema", () => {
    const tool = createPrepareReviseResumeItemTool();

    expect(tool.name).toBe("prepare_revise_resume_item");
    expect(tool.mutability).toBe("read");
    expect(tool.requiresConfirmation).toBe(false);
    expect(tool.riskLevel).toBe("low");
    expect(tool.ownerAgent).toBe("architect");
    // Input/output schemas are defined and non-null
    expect(tool.inputSchema).toBeDefined();
    expect(tool.outputSchema).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// JD match tool prompt in PromptRegistry
// ═══════════════════════════════════════════════════════════════

describe("JD match prompt in PromptRegistry", () => {
  it("loads the migrated JD match system prompt", () => {
    const registry = new PromptRegistry();

    const prompt = registry.get("tools.experience.jdMatch.system");

    expect(prompt).toContain("senior recruiting analyst and resume-to-JD matching assistant");
    expect(prompt).toContain("using evidence, not keyword coincidence");
    expect(prompt).toContain("A matched requirement is valid ONLY");
    expect(prompt).toContain("experienceIndex");
    expect(prompt).toContain("matchScore: 0.0-1.0");
    expect(prompt).toContain("matchLevel: \"high\" | \"medium\" | \"low\"");
    expect(prompt).toContain("matchedRequirements");
    expect(prompt).toContain("missingRequirements");
    expect(prompt).toContain("evidenceFromExperience");
    expect(prompt).toContain("rewriteSuggestion");
    expect(prompt).toContain("High >= 0.75, Medium >= 0.45, Low < 0.45");
    expect(prompt).toContain("Output ONLY a valid JSON array. No markdown, no explanation.");
    expect(prompt.endsWith("No markdown, no explanation.")).toBe(true);
  });

  it("throws a clear error for an unregistered JD match prompt key", () => {
    const registry = new PromptRegistry();

    expect(() => registry.get("tools.experience.missing" as any)).toThrow(
      "Prompt not registered: tools.experience.missing",
    );
  });

  it("matchExperiencesAgainstJDTool returns a tool with correct id, contract, and schema", () => {
    const tool = matchExperiencesAgainstJDTool();

    expect(tool.name).toBe("match_experiences_against_jd");
    expect(tool.mutability).toBe("read");
    expect(tool.requiresConfirmation).toBe(false);
    expect(tool.riskLevel).toBe("low");
    expect(tool.ownerAgent).toBe("experience_receiver");
    expect(tool.inputSchema).toBeDefined();
    expect(tool.outputSchema).toBeDefined();
  });
});
