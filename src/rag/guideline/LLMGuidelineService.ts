import type { ModelClient } from "../../agent-core/model/ModelClient.js";
import { PromptRegistry } from "../../agent-core/prompts/PromptRegistry.js";
import { extractJsonCandidates } from "../../infrastructure/llm/JsonOutputParser.js";
import type { GuidelineQueryPlan, GuidelineRoleAnalysis, GuidelineRoleFamily, InstructionPack, RetrievedGuideline } from "./types.js";
import { deterministicAnalyze } from "./GuidelineRoleAnalyzer.js";

const PROMPTS = new PromptRegistry();
const ROLE_ANALYSIS_SYSTEM = PROMPTS.get("product.guideline.roleAnalysisSystem");
const INSTRUCTION_SYSTEM = PROMPTS.get("product.guideline.instructionSystem");
const ROLE_FAMILIES = ["ai_ml", "software", "data", "product", "research", "consulting", "finance", "general"] as const;

export class LLMGuidelineService {
  public constructor(private readonly modelClient: ModelClient) {}

  public async analyzeRole(input: { jdText: string; targetRole?: string }): Promise<GuidelineRoleAnalysis> {
    const fallback = deterministicAnalyze(input.jdText, input.targetRole);
    const response = await this.modelClient.chat({
      messages: [
        { role: "system", content: ROLE_ANALYSIS_SYSTEM },
        { role: "user", content: [`Target role: ${input.targetRole ?? "unknown"}`, "", "JD:", input.jdText.slice(0, 7000)].join("\n") },
      ],
      temperature: 0.1,
      maxTokens: 2600,
      responseFormat: "json",
    });
    const parsed = firstJsonObject(response.content);
    if (!parsed) return fallback;
    const roleFamily = oneOf(parsed.roleFamily, ROLE_FAMILIES) ?? fallback.roleFamily;
    const secondary = stringArray(parsed.secondaryRoleFamilies)
      .filter((item): item is GuidelineRoleFamily => (ROLE_FAMILIES as readonly string[]).includes(item) && item !== roleFamily)
      .slice(0, 3);
    return {
      roleFamily,
      secondaryRoleFamilies: secondary.length > 0 ? secondary : fallback.secondaryRoleFamilies,
      industry: stringOrUndefined(parsed.industry) ?? fallback.industry,
      applicationType: oneOf(parsed.applicationType, ["job", "internship", "school", "research"] as const) ?? fallback.applicationType,
      language: oneOf(parsed.language, ["zh", "en"] as const) ?? fallback.language,
      priorityRequirements: stringArray(parsed.priorityRequirements).slice(0, 14),
      keywords: stringArray(parsed.keywords).slice(0, 80),
      targetSeniority: oneOf(parsed.targetSeniority, ["student", "intern", "junior", "experienced", "unknown"] as const) ?? fallback.targetSeniority,
      emphasisDimensions: stringArray(parsed.emphasisDimensions).slice(0, 12),
    };
  }

  public async buildInstructionPack(input: {
    jdText: string;
    targetRole?: string;
    analysis: GuidelineRoleAnalysis;
    queryPlan: GuidelineQueryPlan;
    retrieved: RetrievedGuideline[];
  }): Promise<InstructionPack> {
    const response = await this.modelClient.chat({
      messages: [
        { role: "system", content: INSTRUCTION_SYSTEM },
        { role: "user", content: JSON.stringify({
          targetRole: input.targetRole,
          jdText: input.jdText.slice(0, 7000),
          roleAnalysis: input.analysis,
          queryPlan: input.queryPlan,
          retrievedGuidelines: input.retrieved.map((item) => ({
            id: item.guideline.id,
            title: item.guideline.title,
            sourceType: item.guideline.sourceType,
            ruleKind: item.guideline.metadata.ruleKind,
            mandatory: item.guideline.metadata.mandatory,
            content: item.guideline.content,
            tags: item.guideline.tags,
            score: item.score,
          })),
        }) },
      ],
      temperature: 0.15,
      maxTokens: 5000,
      responseFormat: "json",
    });
    const parsed = firstJsonObject(response.content);
    if (!parsed) throw new Error("No JSON instruction pack returned.");
    return {
      version: "guideline-rag-v2",
      targetPositioning: stringOrUndefined(parsed.targetPositioning) ?? "Position the candidate using the strongest evidence-backed role fit.",
      roleFamily: input.analysis.roleFamily,
      industry: input.analysis.industry,
      applicationType: input.analysis.applicationType,
      language: input.analysis.language,
      priorityRequirements: stringArray(parsed.priorityRequirements).slice(0, 14),
      sectionStrategy: isRecord(parsed.sectionStrategy) ? {
        summary: stringOrUndefined(parsed.sectionStrategy.summary),
        experience: stringOrUndefined(parsed.sectionStrategy.experience),
        project: stringOrUndefined(parsed.sectionStrategy.project),
        skills: stringOrUndefined(parsed.sectionStrategy.skills),
        education: stringOrUndefined(parsed.sectionStrategy.education),
      } : {},
      sectionBudgets: isRecord(parsed.sectionBudgets) ? {
        summary: stringOrUndefined(parsed.sectionBudgets.summary),
        experience: stringOrUndefined(parsed.sectionBudgets.experience),
        project: stringOrUndefined(parsed.sectionBudgets.project),
        skills: stringOrUndefined(parsed.sectionBudgets.skills),
        education: stringOrUndefined(parsed.sectionBudgets.education),
      } : undefined,
      writingRules: stringArray(parsed.writingRules).slice(0, 16),
      negativeConstraints: stringArray(parsed.negativeConstraints).slice(0, 16),
      hardConstraints: stringArray(parsed.hardConstraints).slice(0, 16),
      softPreferences: stringArray(parsed.softPreferences).slice(0, 16),
      examplePatterns: Array.isArray(parsed.examplePatterns) ? parsed.examplePatterns.slice(0, 10).map((item, index) => isRecord(item) ? {
        pattern: stringOrUndefined(item.pattern) ?? String(item).slice(0, 240),
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
      queryPlan: input.queryPlan,
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
