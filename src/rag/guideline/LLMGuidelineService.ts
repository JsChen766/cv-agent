import type { ModelClient } from "../../agent-core/model/ModelClient.js";
import { PromptRegistry } from "../../agent-core/prompts/PromptRegistry.js";
import { extractJsonCandidates } from "../../infrastructure/llm/JsonOutputParser.js";
import type { GuidelineRoleAnalysis, InstructionPack, RetrievedGuideline } from "./types.js";
import { deterministicAnalyze } from "./GuidelineRoleAnalyzer.js";

const PROMPTS = new PromptRegistry();
const ROLE_ANALYSIS_SYSTEM = PROMPTS.get("product.guideline.roleAnalysisSystem");
const INSTRUCTION_SYSTEM = PROMPTS.get("product.guideline.instructionSystem");

export class LLMGuidelineService {
  public constructor(private readonly modelClient: ModelClient) {}

  public async analyzeRole(input: { jdText: string; targetRole?: string }): Promise<GuidelineRoleAnalysis> {
    const fallback = deterministicAnalyze(input.jdText, input.targetRole);
    const response = await this.modelClient.chat({
      messages: [
        { role: "system", content: ROLE_ANALYSIS_SYSTEM },
        { role: "user", content: [`Target role: ${input.targetRole ?? "unknown"}`, "", "JD:", input.jdText.slice(0, 5000)].join("\n") },
      ],
      temperature: 0.1,
      maxTokens: 2048,
      responseFormat: "json",
    });
    const parsed = firstJsonObject(response.content);
    if (!parsed) return fallback;
    return {
      roleFamily: stringOrUndefined(parsed.roleFamily) ?? fallback.roleFamily,
      industry: stringOrUndefined(parsed.industry) ?? fallback.industry,
      applicationType: oneOf(parsed.applicationType, ["job", "internship", "school", "research"] as const) ?? fallback.applicationType,
      language: oneOf(parsed.language, ["zh", "en"] as const) ?? fallback.language,
      priorityRequirements: stringArray(parsed.priorityRequirements).slice(0, 12),
      keywords: stringArray(parsed.keywords).slice(0, 60),
      targetSeniority: oneOf(parsed.targetSeniority, ["student", "intern", "junior", "experienced", "unknown"] as const) ?? fallback.targetSeniority,
    };
  }

  public async buildInstructionPack(input: {
    jdText: string;
    targetRole?: string;
    analysis: GuidelineRoleAnalysis;
    retrieved: RetrievedGuideline[];
  }): Promise<InstructionPack> {
    const response = await this.modelClient.chat({
      messages: [
        { role: "system", content: INSTRUCTION_SYSTEM },
        { role: "user", content: JSON.stringify({
          targetRole: input.targetRole,
          jdText: input.jdText.slice(0, 5000),
          roleAnalysis: input.analysis,
          retrievedGuidelines: input.retrieved.map((item) => ({
            id: item.guideline.id,
            title: item.guideline.title,
            sourceType: item.guideline.sourceType,
            content: item.guideline.content,
            tags: item.guideline.tags,
            score: item.score,
          })),
        }) },
      ],
      temperature: 0.2,
      maxTokens: 4096,
      responseFormat: "json",
    });
    const parsed = firstJsonObject(response.content);
    if (!parsed) throw new Error("No JSON instruction pack returned.");
    return {
      version: "guideline-rag-v1.5",
      targetPositioning: typeof parsed.targetPositioning === "string" ? parsed.targetPositioning : "Position the candidate using evidence-backed role fit.",
      roleFamily: input.analysis.roleFamily,
      industry: input.analysis.industry,
      applicationType: input.analysis.applicationType,
      language: input.analysis.language,
      priorityRequirements: stringArray(parsed.priorityRequirements).slice(0, 12),
      sectionStrategy: isRecord(parsed.sectionStrategy) ? {
        summary: stringOrUndefined(parsed.sectionStrategy.summary),
        experience: stringOrUndefined(parsed.sectionStrategy.experience),
        project: stringOrUndefined(parsed.sectionStrategy.project),
        skills: stringOrUndefined(parsed.sectionStrategy.skills),
        education: stringOrUndefined(parsed.sectionStrategy.education),
      } : {},
      writingRules: stringArray(parsed.writingRules).slice(0, 12),
      negativeConstraints: stringArray(parsed.negativeConstraints).slice(0, 12),
      examplePatterns: Array.isArray(parsed.examplePatterns) ? parsed.examplePatterns.slice(0, 8).map((item, index) => isRecord(item) ? {
        pattern: stringOrUndefined(item.pattern) ?? String(item).slice(0, 200),
        useCase: stringOrUndefined(item.useCase) ?? `Pattern ${index + 1}`,
        sourceGuidelineId: stringOrUndefined(item.sourceGuidelineId),
      } : { pattern: String(item), useCase: `Pattern ${index + 1}` }) : [],
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

function firstJsonObject(content: string): Record<string, unknown> | null {
  for (const candidate of extractJsonCandidates(content)) {
    try {
      const parsed = JSON.parse(candidate.text);
      if (isRecord(parsed)) return parsed;
    } catch {
      // continue
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function oneOf<T extends readonly string[]>(value: unknown, allowed: T): T[number] | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T[number] : undefined;
}
