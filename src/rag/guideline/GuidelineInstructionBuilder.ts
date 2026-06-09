import type { GuidelineRoleAnalysis, InstructionPack, RetrievedGuideline } from "./types.js";
import type { LLMGuidelineService } from "./LLMGuidelineService.js";
import { unique } from "./textUtils.js";

export class GuidelineInstructionBuilder {
  public constructor(private readonly llmGuidelineService?: LLMGuidelineService) {}

  public async build(input: {
    jdText: string;
    targetRole?: string;
    analysis: GuidelineRoleAnalysis;
    retrieved: RetrievedGuideline[];
  }): Promise<InstructionPack> {
    if (this.llmGuidelineService) {
      try {
        const pack = await this.llmGuidelineService.buildInstructionPack(input);
        if (pack.writingRules.length > 0 || pack.negativeConstraints.length > 0) return pack;
      } catch (error) {
        if (process.env.DEBUG_GUIDELINE_RAG === "true") {
          console.warn("[GuidelineInstructionBuilder] LLM synthesis failed, using deterministic fallback", error);
        }
      }
    }
    return this.buildDeterministic(input);
  }

  private buildDeterministic(input: {
    jdText: string;
    targetRole?: string;
    analysis: GuidelineRoleAnalysis;
    retrieved: RetrievedGuideline[];
  }): InstructionPack {
    const role = input.targetRole ?? input.analysis.roleFamily ?? "target role";
    const retrievedRules = input.retrieved.map((item) => item.guideline.content);
    const writingRules = unique([
      "Use action-context-result structure for resume bullets.",
      "Prioritize requirements that are important in the JD and supported by evidence.",
      "Use concise, professional wording and avoid keyword stuffing.",
      ...retrievedRules.filter((rule) => /should|prioritize|emphasize|prefer|保持|突出|避免/i.test(rule)).slice(0, 5),
    ]).slice(0, 8);
    const negativeConstraints = unique([
      "Do not invent metrics, roles, companies, leadership, launches, users, or outcomes.",
      "Do not use strong ownership verbs such as led, owned, or drove unless evidence explicitly supports them.",
      "If a requirement lacks evidence, mark it as missing or ask for confirmation instead of forcing it into the resume.",
      ...retrievedRules.filter((rule) => /do not|avoid|不能|不得|避免|unsupported/i.test(rule)).slice(0, 4),
    ]).slice(0, 8);
    return {
      version: "guideline-rag-v1.5",
      targetPositioning: `Position the candidate for ${role} by emphasizing evidence-backed experiences that match the JD without overstating factual claims.`,
      roleFamily: input.analysis.roleFamily,
      industry: input.analysis.industry,
      applicationType: input.analysis.applicationType,
      language: input.analysis.language,
      priorityRequirements: input.analysis.priorityRequirements.slice(0, 10),
      sectionStrategy: {
        summary: "Summarize role fit only when there is strong supporting evidence.",
        experience: "Rank experiences by JD relevance, evidence strength, and factual support.",
        project: "For project items, highlight method, responsibility, technical or analytical contribution, and verified outcome.",
        skills: "List skills only when they are supported by experience evidence or user-provided facts.",
        education: "Keep education and awards concise unless they directly support the target role.",
      },
      writingRules,
      negativeConstraints,
      examplePatterns: input.retrieved.slice(0, 5).map((item) => ({
        pattern: item.guideline.content.slice(0, 220),
        useCase: item.guideline.title,
        sourceGuidelineId: item.guideline.id,
      })),
      retrievalTrace: input.retrieved.map((item) => ({
        guidelineId: item.guideline.id,
        title: item.guideline.title,
        sourceType: item.guideline.sourceType,
        score: Number(item.score.toFixed(3)),
        matchedTags: item.matchedTags,
        reason: item.reason,
      })),
    };
  }
}
