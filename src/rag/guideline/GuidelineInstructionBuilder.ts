import type { GuidelineQueryPlan, GuidelineRoleAnalysis, InstructionPack, RetrievedGuideline } from "./types.js";
import type { LLMGuidelineService } from "./LLMGuidelineService.js";
import { InstructionPackQualityGate } from "./InstructionPackQualityGate.js";
import { unique } from "./textUtils.js";

export class GuidelineInstructionBuilder {
  private readonly qualityGate = new InstructionPackQualityGate();

  public constructor(private readonly llmGuidelineService?: LLMGuidelineService) {}

  public async build(input: {
    jdText: string;
    targetRole?: string;
    analysis: GuidelineRoleAnalysis;
    queryPlan: GuidelineQueryPlan;
    retrieved: RetrievedGuideline[];
  }): Promise<InstructionPack> {
    let pack: InstructionPack | undefined;
    if (this.llmGuidelineService) {
      try {
        const candidate = await this.llmGuidelineService.buildInstructionPack(input);
        if (candidate.writingRules.length > 0 || candidate.negativeConstraints.length > 0) pack = candidate;
      } catch (error) {
        if (process.env.DEBUG_GUIDELINE_RAG === "true") {
          console.warn("[GuidelineInstructionBuilder] LLM synthesis failed, using deterministic fallback", error);
        }
      }
    }
    pack ??= this.buildDeterministic(input);
    return this.qualityGate.finalize({
      pack,
      analysis: input.analysis,
      retrieved: input.retrieved,
      queryPlan: input.queryPlan,
    });
  }

  private buildDeterministic(input: {
    targetRole?: string;
    analysis: GuidelineRoleAnalysis;
    queryPlan: GuidelineQueryPlan;
    retrieved: RetrievedGuideline[];
  }): InstructionPack {
    const role = input.targetRole ?? readableRole(input.analysis.roleFamily);
    const byKind = (kind: string) => input.retrieved.filter((item) => item.guideline.metadata.ruleKind === kind);
    const hardConstraints = unique(byKind("hard_constraint").map((item) => item.guideline.content));
    const writingRules = unique([
      "Use an action-method-scope-result structure and keep one main contribution per bullet.",
      "Prioritize critical JD requirements only when supported by verified evidence.",
      "Use concise, natural wording and integrate exact JD terminology without keyword stuffing.",
      ...byKind("writing_rule").map((item) => item.guideline.content),
      ...input.retrieved.filter((item) => item.guideline.sourceType === "role_template").map((item) => item.guideline.content),
    ]).slice(0, 14);
    const negativeConstraints = unique([
      ...hardConstraints,
      "Do not turn recommendations into implemented outcomes or prototypes into production deployments.",
      "Do not infer numbers, scope, authorship, publication status, or leadership from weak semantic similarity.",
    ]).slice(0, 14);
    const roleGuidelines = input.retrieved.filter((item) => item.guideline.roleFamily === input.analysis.roleFamily);
    return {
      version: "guideline-rag-v2",
      targetPositioning: `Position the candidate for ${role} using the strongest evidence-backed technical, analytical, research, or impact signals required by the JD, while preserving factual ownership boundaries.`,
      roleFamily: input.analysis.roleFamily,
      industry: input.analysis.industry,
      applicationType: input.analysis.applicationType,
      language: input.analysis.language,
      priorityRequirements: input.analysis.priorityRequirements.slice(0, 12),
      sectionStrategy: {
        summary: "Use a concise target-role summary only when several verified claims support a coherent positioning.",
        experience: roleGuidelines[0]?.guideline.content ?? "Rank experiences by critical-requirement coverage, evidence strength, distinctiveness, and recency.",
        project: "For each selected project, state the verified problem, method, individual contribution, and outcome; do not overstate deployment or ownership.",
        skills: "Group only verified and relevant skills; prefer skills demonstrated by selected experiences.",
        education: "Keep degrees and honors exact and compact; expand only items that materially support role fit.",
      },
      sectionBudgets: {
        summary: "0-3 lines",
        experience: "2-4 strongest items; 2-4 bullets each",
        project: "Only distinct, role-relevant projects",
        skills: "Compact grouped list",
        education: "Compact factual entries",
      },
      writingRules,
      negativeConstraints,
      hardConstraints,
      softPreferences: writingRules,
      examplePatterns: byKind("example_pattern").slice(0, 8).map((item) => ({
        pattern: item.guideline.content,
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
      queryPlan: input.queryPlan,
    };
  }
}

function readableRole(role: GuidelineRoleAnalysis["roleFamily"]): string {
  return ({
    ai_ml: "AI/ML role",
    software: "software engineering role",
    data: "data and analytics role",
    product: "product role",
    research: "research role",
    consulting: "consulting role",
    finance: "finance role",
    general: "target role",
  } as const)[role];
}
