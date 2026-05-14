import { z } from "zod";
import type { BaseAgent } from "../../core/agent/BaseAgent.js";
import { parseAgentJson } from "../../core/json/index.js";
import { stableId } from "../../knowledge/keywordUtils.js";
import { parseWithSchema } from "../../knowledge/schemas/validate.js";
import type { RequirementCoverageItem } from "../evaluation/types.js";
import type { CoverageGapAdvisor } from "./CoverageGapAdvisor.js";
import type {
  AdviseCoverageGapsInput,
  CoverageGapReport,
} from "./types.js";

const RiskLevelSchema = z.enum(["low", "medium", "high"]);
const CoverageGapTypeSchema = z.enum([
  "missing_artifact",
  "missing_evidence",
  "weak_coverage",
]);
const CoverageGapSeveritySchema = z.enum(["low", "medium", "high"]);

const SupplementalArtifactSuggestionSchema = z.object({
  type: z.enum(["resume_bullet", "resume_summary", "cover_letter_snippet"]),
  content: z.string(),
  sourceExperienceIds: z.array(z.string()),
  sourceEvidenceIds: z.array(z.string()),
  matchedSkillIds: z.array(z.string()),
  targetRequirementIds: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  riskLevel: RiskLevelSchema,
  rationale: z.string(),
});

const EvidenceRequestSuggestionSchema = z.object({
  prompt: z.string(),
  expectedEvidenceType: z.enum([
    "project",
    "metric",
    "collaboration",
    "leadership",
    "business_impact",
    "technical_detail",
    "other",
  ]),
  reason: z.string(),
});

const AgentCoverageGapItemSchema = z.object({
  requirementId: z.string(),
  gapType: CoverageGapTypeSchema,
  severity: CoverageGapSeveritySchema,
  existingEvidenceIds: z.array(z.string()),
  existingArtifactIds: z.array(z.string()),
  supplementalArtifactSuggestions: z.array(SupplementalArtifactSuggestionSchema),
  evidenceRequestSuggestions: z.array(EvidenceRequestSuggestionSchema),
  reason: z.string(),
});

const AgentCoverageGapOutputSchema = z.object({
  items: z.array(AgentCoverageGapItemSchema),
  supplementalArtifactCount: z.number().int().nonnegative(),
  evidenceRequestCount: z.number().int().nonnegative(),
  summary: z.string(),
});

export class AgentCoverageGapAdvisor implements CoverageGapAdvisor {
  constructor(private readonly agent: BaseAgent) {}

  async advise(input: AdviseCoverageGapsInput): Promise<CoverageGapReport> {
    const output = await this.agent.run({
      content: this.buildPrompt(input),
      responseFormat: "json",
    });
    const parsed = parseAgentJson(output.content, { expectedRoot: "object" });
    const validated = parseWithSchema(
      AgentCoverageGapOutputSchema,
      parsed,
      "AgentCoverageGapAdvisor",
    );
    const requirementById = new Map(
      input.coverageReport.items.map((item) => [item.requirement.id, item.requirement]),
    );
    const createdAt = new Date().toISOString();

    return {
      id: stableId("coverage-gap", `${input.userId}:${input.jdId}:${createdAt}`),
      userId: input.userId,
      jdId: input.jdId,
      items: validated.items.map((item) => {
        const requirement = requirementById.get(item.requirementId);
        if (!requirement) {
          throw new Error(
            `AgentCoverageGapAdvisor returned unknown requirementId: ${item.requirementId}`,
          );
        }
        return {
          requirement,
          gapType: item.gapType,
          severity: item.severity,
          existingEvidenceIds: item.existingEvidenceIds,
          existingArtifactIds: item.existingArtifactIds,
          supplementalArtifactSuggestions: item.supplementalArtifactSuggestions,
          evidenceRequestSuggestions: item.evidenceRequestSuggestions,
          reason: item.reason,
        };
      }),
      supplementalArtifactCount: validated.supplementalArtifactCount,
      evidenceRequestCount: validated.evidenceRequestCount,
      summary: validated.summary,
      createdAt,
    };
  }

  private buildPrompt(input: AdviseCoverageGapsInput): string {
    return [
      "Review this coverage report and suggest coverage gap actions. Return only the required JSON object.",
      "Do not modify existing artifacts. Do not invent evidence. Supplemental suggestions must cite only provided evidence ids.",
      `userId: ${input.userId}`,
      `jdId: ${input.jdId}`,
      `coverageReport: ${JSON.stringify({
        summary: input.coverageReport.summary,
        items: input.coverageReport.items.map((item) =>
          this.coverageItemForPrompt(item),
        ),
      })}`,
      `retrievedEvidence: ${JSON.stringify(input.retrievedExperiences.flatMap((entry) =>
        entry.evidences.map((evidence) => ({
          id: evidence.id,
          experienceId: evidence.experienceId,
          excerpt: evidence.excerpt,
        })),
      ))}`,
      `artifacts: ${JSON.stringify(input.artifacts.map((artifact) => ({
        id: artifact.id,
        content: artifact.content,
        sourceEvidenceIds: artifact.sourceEvidenceIds,
        targetRequirementIds: artifact.targetRequirementIds,
      })))}`,
      "Output schema: {\"items\":[{\"requirementId\":\"string\",\"gapType\":\"missing_artifact|missing_evidence|weak_coverage\",\"severity\":\"low|medium|high\",\"existingEvidenceIds\":[\"string\"],\"existingArtifactIds\":[\"string\"],\"supplementalArtifactSuggestions\":[{\"type\":\"resume_bullet|resume_summary|cover_letter_snippet\",\"content\":\"string\",\"sourceExperienceIds\":[\"string\"],\"sourceEvidenceIds\":[\"string\"],\"matchedSkillIds\":[\"string\"],\"targetRequirementIds\":[\"string\"],\"confidence\":0.75,\"riskLevel\":\"low|medium|high\",\"rationale\":\"string\"}],\"evidenceRequestSuggestions\":[{\"prompt\":\"string\",\"expectedEvidenceType\":\"project|metric|collaboration|leadership|business_impact|technical_detail|other\",\"reason\":\"string\"}],\"reason\":\"string\"}],\"supplementalArtifactCount\":0,\"evidenceRequestCount\":0,\"summary\":\"string\"}",
    ].join("\n");
  }

  private coverageItemForPrompt(item: RequirementCoverageItem) {
    return {
      requirementId: item.requirement.id,
      description: item.requirement.description,
      status: item.status,
      coveredByArtifactIds: item.coveredByArtifactIds,
      supportingEvidenceIds: item.supportingEvidenceIds,
      supportingSkillIds: item.supportingSkillIds,
      reason: item.reason,
      suggestions: item.suggestions,
    };
  }
}
