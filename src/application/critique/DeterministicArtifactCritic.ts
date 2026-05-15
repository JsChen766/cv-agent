import { stableId, tokenize } from "../../knowledge/keywordUtils.js";
import type { EvidenceChain, GeneratedArtifact, RiskLevel } from "../../knowledge/types.js";
import type {
  ArtifactCandidateStatus,
  ArtifactClaim,
} from "../generators/ArtifactGenerator.js";
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
    const enhancement = this.readEnhancement(artifact);
    const enhancementAssessment = this.assessEnhancement(enhancement);
    const verdict = this.maxVerdict(
      this.verdictForRisk(chain?.risk.level ?? "high"),
      enhancementAssessment.verdict,
    );
    const truthfulnessRisk = this.maxRisk(
      chain?.risk.truthfulnessRisk ?? "high",
      enhancementAssessment.truthfulnessRisk,
    );
    const exaggerationRisk = this.maxRisk(
      chain?.risk.exaggerationRisk ?? "high",
      enhancementAssessment.exaggerationRisk,
    );
    const unsupportedClaims = unique([
      ...(chain?.risk.exaggerationWarnings ?? []),
      ...enhancementAssessment.unsupportedClaims,
    ]);
    const missingEvidence = unique([
      ...(chain?.risk.missingEvidenceClaims ?? [
        "Generated artifact has no evidence chain.",
      ]),
      ...enhancementAssessment.missingEvidence,
    ]);
    const rewriteSuggestions = unique([
      ...(verdict === "pass"
        ? []
        : ["Revise the artifact to match only claims supported by linked evidence."]),
      ...enhancementAssessment.rewriteSuggestions,
    ]);

    return {
      artifactId,
      verdict,
      truthfulnessRisk,
      exaggerationRisk,
      specificityScore: this.specificityScore(artifact.content),
      evidenceStrengthScore: artifact.scores.evidenceStrength,
      unsupportedClaims,
      missingEvidence,
      rewriteSuggestions,
      ...(enhancementAssessment.confirmationQuestions.length > 0
        ? { confirmationQuestions: enhancementAssessment.confirmationQuestions }
        : {}),
      ...(enhancementAssessment.claimReviews.length > 0
        ? { claimReviews: enhancementAssessment.claimReviews }
        : {}),
      ...(rewriteSuggestions[0] ? { safeRewriteSuggestion: rewriteSuggestions[0] } : {}),
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

  private assessEnhancement(enhancement: ArtifactEnhancement | null): EnhancementAssessment {
    if (!enhancement) {
      return {
        verdict: "pass",
        truthfulnessRisk: "low",
        exaggerationRisk: "low",
        unsupportedClaims: [],
        missingEvidence: [],
        rewriteSuggestions: [],
        confirmationQuestions: [],
        claimReviews: [],
      };
    }

    let verdict: ArtifactCritiqueVerdict = "pass";
    let truthfulnessRisk: RiskLevel = "low";
    let exaggerationRisk: RiskLevel = "low";
    const unsupportedClaims: string[] = [];
    const missingEvidence: string[] = [];
    const rewriteSuggestions: string[] = [];
    const confirmationQuestions = [...enhancement.confirmationQuestions];
    const claimReviews: NonNullable<ArtifactCritiqueItem["claimReviews"]> = [];

    if (enhancement.status === "unsafe") {
      verdict = "reject";
      truthfulnessRisk = "high";
      exaggerationRisk = "high";
      rewriteSuggestions.push("Remove unsafe or unsupported claims before using this artifact.");
    } else if (enhancement.status === "needs_confirmation") {
      verdict = "revise";
      truthfulnessRisk = "medium";
      exaggerationRisk = "medium";
      missingEvidence.push(...confirmationQuestions);
      rewriteSuggestions.push(...confirmationQuestions);
    }

    for (const claim of enhancement.claims) {
      const claimVerdict = this.verdictForClaim(claim);
      claimReviews.push({
        claimText: claim.text,
        supportLevel: claim.supportLevel,
        riskLevel: claim.riskLevel,
        verdict: claimVerdict,
        reason: this.reasonForClaim(claim),
        evidenceIds: claim.evidenceIds,
      });
      verdict = this.maxVerdict(verdict, claimVerdict);
      truthfulnessRisk = this.maxRisk(truthfulnessRisk, claim.riskLevel);
      exaggerationRisk = this.maxRisk(exaggerationRisk, claim.riskLevel);

      if (claim.supportLevel === "unsupported") {
        unsupportedClaims.push(claim.text);
      }
      if (claim.supportLevel === "needs_user_confirmation") {
        const prompt = claim.userConfirmationPrompt ?? claim.text;
        missingEvidence.push(prompt);
        rewriteSuggestions.push(prompt);
      }
      if (claim.supportLevel === "unsupported" && claim.riskLevel === "high") {
        rewriteSuggestions.push("Remove unsupported high-risk claim or replace it with cited evidence.");
      }
    }

    return {
      verdict,
      truthfulnessRisk,
      exaggerationRisk,
      unsupportedClaims: unique(unsupportedClaims),
      missingEvidence: unique(missingEvidence),
      rewriteSuggestions: unique(rewriteSuggestions),
      confirmationQuestions: unique(confirmationQuestions),
      claimReviews,
    };
  }

  private verdictForClaim(claim: ArtifactClaim): ArtifactCritiqueVerdict {
    if (claim.supportLevel === "unsupported") {
      return "reject";
    }
    if (claim.supportLevel === "needs_user_confirmation") {
      return "revise";
    }
    return "pass";
  }

  private reasonForClaim(claim: ArtifactClaim): string {
    if (claim.supportLevel === "unsupported") {
      return "Claim is marked unsupported in artifact enhancement metadata.";
    }
    if (claim.supportLevel === "needs_user_confirmation") {
      return claim.userConfirmationPrompt ?? "Claim requires user confirmation before use.";
    }
    if (claim.supportLevel === "inferred") {
      return "Claim is an inference and should remain grounded in cited evidence.";
    }
    return "Claim is marked supported by cited evidence.";
  }

  private maxVerdict(
    left: ArtifactCritiqueVerdict,
    right: ArtifactCritiqueVerdict,
  ): ArtifactCritiqueVerdict {
    const order: Record<ArtifactCritiqueVerdict, number> = {
      pass: 0,
      revise: 1,
      reject: 2,
    };
    return order[left] >= order[right] ? left : right;
  }

  private maxRisk(left: RiskLevel, right: RiskLevel): RiskLevel {
    const order: Record<RiskLevel, number> = {
      low: 0,
      medium: 1,
      high: 2,
    };
    return order[left] >= order[right] ? left : right;
  }

  private readEnhancement(artifact: GeneratedArtifact): ArtifactEnhancement | null {
    const enhancement = artifact.metadata?.enhancement;
    if (typeof enhancement !== "object" || enhancement === null || Array.isArray(enhancement)) {
      return null;
    }
    const record = enhancement as Record<string, unknown>;
    const status = readStatus(record.status);
    const claims = readClaims(record.claims);
    const confirmationQuestions = Array.isArray(record.confirmationQuestions)
      ? record.confirmationQuestions.filter((value): value is string => typeof value === "string")
      : [];
    if (!status && claims.length === 0 && confirmationQuestions.length === 0) {
      return null;
    }
    return {
      status: status ?? "ready",
      claims,
      confirmationQuestions,
    };
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

type ArtifactEnhancement = {
  status: ArtifactCandidateStatus;
  claims: ArtifactClaim[];
  confirmationQuestions: string[];
};

type EnhancementAssessment = {
  verdict: ArtifactCritiqueVerdict;
  truthfulnessRisk: RiskLevel;
  exaggerationRisk: RiskLevel;
  unsupportedClaims: string[];
  missingEvidence: string[];
  rewriteSuggestions: string[];
  confirmationQuestions: string[];
  claimReviews: NonNullable<ArtifactCritiqueItem["claimReviews"]>;
};

function readStatus(value: unknown): ArtifactCandidateStatus | null {
  if (value === "ready" || value === "needs_confirmation" || value === "unsafe") {
    return value;
  }
  return null;
}

function readClaims(value: unknown): ArtifactClaim[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const claims: ArtifactClaim[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.text !== "string" ||
      !isSupportLevel(record.supportLevel) ||
      !isRiskLevel(record.riskLevel)
    ) {
      continue;
    }
    claims.push({
      text: record.text,
      supportLevel: record.supportLevel,
      riskLevel: record.riskLevel,
      evidenceIds: readStringArray(record.evidenceIds),
      sourceExperienceIds: readStringArray(record.sourceExperienceIds),
      ...(typeof record.userConfirmationPrompt === "string"
        ? { userConfirmationPrompt: record.userConfirmationPrompt }
        : {}),
    });
  }
  return claims;
}

function isSupportLevel(value: unknown): value is ArtifactClaim["supportLevel"] {
  return value === "supported" ||
    value === "inferred" ||
    value === "needs_user_confirmation" ||
    value === "unsupported";
}

function isRiskLevel(value: unknown): value is ArtifactClaim["riskLevel"] {
  return value === "low" || value === "medium" || value === "high";
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
