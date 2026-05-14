import { z } from "zod";
import type { BaseAgent } from "../../core/agent/BaseAgent.js";
import { parseAgentJson } from "../../core/json/index.js";
import { stableId } from "../../knowledge/keywordUtils.js";
import { parseWithSchema } from "../../knowledge/schemas/validate.js";
import type {
  ArtifactCritic,
  ArtifactCritiqueReport,
  CritiqueArtifactsInput,
} from "./types.js";

const RiskLevelSchema = z.enum(["low", "medium", "high"]);
const ArtifactCritiqueVerdictSchema = z.enum(["pass", "revise", "reject"]);

const AgentCritiqueItemSchema = z.object({
  artifactId: z.string(),
  verdict: ArtifactCritiqueVerdictSchema,
  truthfulnessRisk: RiskLevelSchema,
  exaggerationRisk: RiskLevelSchema,
  specificityScore: z.number().min(0).max(1),
  evidenceStrengthScore: z.number().min(0).max(1),
  unsupportedClaims: z.array(z.string()),
  missingEvidence: z.array(z.string()),
  rewriteSuggestions: z.array(z.string()),
});

const AgentCritiqueOutputSchema = z.object({
  items: z.array(AgentCritiqueItemSchema),
  summary: z.string(),
});

export class AgentArtifactCritic implements ArtifactCritic {
  constructor(private readonly agent: BaseAgent) {}

  async critique(input: CritiqueArtifactsInput): Promise<ArtifactCritiqueReport> {
    const output = await this.agent.run({
      content: this.buildPrompt(input),
      responseFormat: "json",
    });
    const parsed = parseAgentJson(output.content, { expectedRoot: "object" });
    const validated = parseWithSchema(
      AgentCritiqueOutputSchema,
      parsed,
      "AgentArtifactCritic",
    );
    const createdAt = new Date().toISOString();

    return {
      id: stableId("critique", `${input.userId}:${input.jdId}:${createdAt}`),
      userId: input.userId,
      jdId: input.jdId,
      items: validated.items,
      summary: validated.summary,
      createdAt,
    };
  }

  private buildPrompt(input: CritiqueArtifactsInput): string {
    const artifactLines = input.artifacts.map((artifact) => {
      const chain = input.evidenceChains.find((entry) => entry.artifact.id === artifact.id);
      return {
        artifact: {
          id: artifact.id,
          content: artifact.content,
          scores: artifact.scores,
          sourceEvidenceIds: artifact.sourceEvidenceIds,
          targetRequirementIds: artifact.targetRequirementIds,
        },
        evidenceChain: chain
          ? {
            summary: chain.summary,
            risk: chain.risk,
            sourceEvidences: chain.sourceEvidences.map((evidence) => ({
              id: evidence.id,
              evidenceType: evidence.evidenceType,
              excerpt: evidence.excerpt,
            })),
          }
          : null,
      };
    });

    return [
      "Review these generated resume artifacts. Return only the required JSON object.",
      `userId: ${input.userId}`,
      `jdId: ${input.jdId}`,
      `artifactsAndEvidenceChains: ${JSON.stringify(artifactLines)}`,
      `coverageReport: ${JSON.stringify({
        summary: input.coverageReport.summary,
        items: input.coverageReport.items.map((item) => ({
          requirementId: item.requirement.id,
          description: item.requirement.description,
          status: item.status,
          reason: item.reason,
          suggestions: item.suggestions,
        })),
      })}`,
    ].join("\n");
  }
}
