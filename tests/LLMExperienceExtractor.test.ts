import { describe, expect, it } from "vitest";
import {
  buildUserPrompt,
  detectDominantLanguage,
  extractedCandidateToDraft,
  type ExtractedCandidate,
} from "../src/product/LLMExperienceExtractor.js";
import { PromptRegistry } from "../src/agent-core/prompts/PromptRegistry.js";

describe("LLMExperienceExtractor language preservation", () => {
  it("detects Chinese-dominant mixed publication input as zh", () => {
    const text = "帮我添加经历，我以第一作者身份在 Transaction on Multimedia 上发表论文 Hierarchical Structure Consistency Learning for Multimodal Emotion Recognition。";

    expect(detectDominantLanguage(text)).toBe("zh");
  });

  it("detects English input as en", () => {
    expect(detectDominantLanguage("I published a first-author paper in Transactions on Multimedia.")).toBe("en");
  });

  it("adds language requirements to the extraction user prompt", () => {
    const prompt = buildUserPrompt("帮我添加经历，我发表了论文 Paper Title。");

    expect(prompt).toContain("Detected input language: zh.");
    expect(prompt).toContain("Use the dominant language of the input text");
    expect(prompt).toContain("Do not translate the user's experience into another language unless explicitly requested");
    expect(prompt).toContain("Keep proper nouns");
  });

  it("keeps detected language metadata on extracted drafts", () => {
    const candidate: ExtractedCandidate = {
      type: "project",
      title: "第一作者发表多模态情感识别论文",
      projectName: "Hierarchical Structure Consistency Learning for Multimodal Emotion Recognition",
      projectRole: "第一作者",
      content: "以第一作者身份发表论文《Hierarchical Structure Consistency Learning for Multimodal Emotion Recognition》。",
      confidence: 0.8,
    };

    const draft = extractedCandidateToDraft(candidate, "zh");

    expect(draft.structured.inputLanguage).toBe("zh");
    expect(draft.title).toContain("第一作者");
    expect(draft.content).toContain("Hierarchical Structure Consistency Learning for Multimodal Emotion Recognition");
  });

  it("system and repair prompts forbid automatic translation and unverified external details", () => {
    const registry = new PromptRegistry();
    const systemPrompt = registry.get("product.experienceExtraction.system");
    const repairPrompt = registry.get("product.experienceExtraction.repair");

    expect(systemPrompt).toContain("Preserve the user's original language");
    expect(systemPrompt).toContain("Do not translate Chinese input into English unless the user explicitly asks");
    expect(systemPrompt).toContain("Do not translate English paper titles or journal names into Chinese");
    expect(systemPrompt).toContain("Do not fabricate external details");
    expect(repairPrompt).toContain("Preserve the original language");
    expect(repairPrompt).toContain("Do not add unverified external details");
  });
});
