import { stableId, tokenize } from "../../knowledge/keywordUtils.js";
import type { EvidenceChain, GeneratedArtifact } from "../../knowledge/types.js";
import type {
  ArtifactCritic,
  ArtifactCritiqueItem,
  ArtifactCritiqueReport,
  ArtifactCritiqueVerdict,
  CritiqueArtifactsInput,
} from "./types.js";

export class DeterministicArtifactCritic implements ArtifactCritic {
  async critique(input: CritiqueArtifactsInput): Promise<ArtifactCritiqueReport> {
    const createdAt = new Date().toISOString();
    const items = input.artifacts.map((artifact) =>
      this.critiqueArtifact(artifact, input.evidenceChains),
    );
    const passCount = items.filter((item) => item.verdict === "pass").length;
    const reviseCount = items.filter((item) => item.verdict === "revise").length;
    const rejectCount = items.filter((item) => item.verdict === "reject").length;
    const unusedCount = input.coverageReport.evidenceAvailableButNotUsedRequirementIds.length;
    const unusedSentence = unusedCount === 1
      ? "1 requirement has evidence available but is not covered."
      : `${unusedCount} requirements have evidence available but are not covered.`;

    return {
      id: stableId("critique", `${input.userId}:${input.jdId}:${createdAt}`),
      userId: input.userId,
      jdId: input.jdId,
      items,
      summary: `${items.length} artifacts reviewed. ${passCount} passed, ${reviseCount} need revision, ${rejectCount} rejected. ${unusedSentence}`,
      createdAt,
    };
  }

  private critiqueArtifact(
    artifact: GeneratedArtifact,
    evidenceChains: EvidenceChain[],
  ): ArtifactCritiqueItem {
    const artifactId = this.requireArtifactId(artifact);
    const chain = evidenceChains.find((entry) => entry.artifact.id === artifactId);
    const verdict = this.verdictForRisk(chain?.risk.level ?? "high");

    return {
      artifactId,
      verdict,
      truthfulnessRisk: chain?.risk.truthfulnessRisk ?? "high",
      exaggerationRisk: chain?.risk.exaggerationRisk ?? "high",
      specificityScore: this.specificityScore(artifact.content),
      evidenceStrengthScore: artifact.scores.evidenceStrength,
      unsupportedClaims: chain?.risk.exaggerationWarnings ?? [],
      missingEvidence: chain?.risk.missingEvidenceClaims ?? [
        "Generated artifact has no evidence chain.",
      ],
      rewriteSuggestions: verdict === "pass"
        ? []
        : ["Revise the artifact to match only claims supported by linked evidence."],
    };
  }

  private requireArtifactId(artifact: GeneratedArtifact): string {
    if (!artifact.id) {
      throw new Error("Cannot critique artifact without artifact.id.");
    }
    return artifact.id;
  }

  private verdictForRisk(riskLevel: EvidenceChain["risk"]["level"]): ArtifactCritiqueVerdict {
    if (riskLevel === "low") {
      return "pass";
    }
    if (riskLevel === "medium") {
      return "revise";
    }
    return "reject";
  }

  private specificityScore(content: string): number {
    if (/\d|%/.test(content)) {
      return 0.8;
    }
    const tokens = new Set(tokenize(content));
    const technicalTerms = [
      "react",
      "typescript",
      "wcag",
      "accessibility",
      "performance",
      "bundle",
      "api",
      "design",
      "component",
    ];
    return technicalTerms.some((term) => tokens.has(term)) ? 0.8 : 0.6;
  }
}
