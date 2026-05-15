import type { CritiqueArtifactsInput } from "./types.js";

export function buildLLMArtifactCritiqueSystemPrompt(): string {
  return [
    "You are an evidence-aware resume CriticAgent.",
    "You do not rewrite the final artifact; you review it.",
    "Use artifact.metadata.enhancement.claims when available.",
    "Use evidence chain risks and cited evidence.",
    "Classify each artifact as pass, revise, or reject.",
    "pass means ready to use.",
    "revise means potentially useful but needs confirmation, narrowing, or safer rewrite.",
    "reject means unsupported, unsafe, or high-risk fabrication.",
    "Reasonable inference is allowed if low-risk and grounded.",
    "User-confirmable quantification is allowed but must not pass until confirmed.",
    "Unsupported high-risk claims must not pass.",
    "Return JSON only.",
    "",
    "Return exactly this JSON shape:",
    "{",
    '  "items": [',
    "    {",
    '      "artifactId": "artifact-id",',
    '      "verdict": "pass | revise | reject",',
    '      "truthfulnessRisk": "low | medium | high",',
    '      "exaggerationRisk": "low | medium | high",',
    '      "specificityScore": 0.8,',
    '      "evidenceStrengthScore": 0.8,',
    '      "unsupportedClaims": ["string"],',
    '      "missingEvidence": ["string"],',
    '      "rewriteSuggestions": ["string"],',
    '      "confirmationQuestions": ["string"],',
    '      "safeRewriteSuggestion": "optional safer wording",',
    '      "claimReviews": [{',
    '        "claimText": "string",',
    '        "supportLevel": "supported | inferred | needs_user_confirmation | unsupported",',
    '        "riskLevel": "low | medium | high",',
    '        "verdict": "pass | revise | reject",',
    '        "reason": "string",',
    '        "evidenceIds": ["ev-id"]',
    "      }]",
    "    }",
    "  ],",
    '  "summary": "string",',
    '  "warnings": ["string"]',
    "}",
  ].join("\n");
}

export function buildLLMArtifactCritiqueUserPrompt(input: CritiqueArtifactsInput): string {
  const evidenceChainsByArtifactId = new Map(
    input.evidenceChains.map((chain) => [chain.artifact.id, chain]),
  );
  return [
    `userId: ${input.userId}`,
    `jdId: ${input.jdId}`,
    "",
    "Artifacts to review:",
    JSON.stringify(input.artifacts.map((artifact) => {
      const chain = evidenceChainsByArtifactId.get(artifact.id);
      return {
        artifact: {
          id: artifact.id,
          content: artifact.content,
          sourceExperienceIds: artifact.sourceExperienceIds,
          sourceEvidenceIds: artifact.sourceEvidenceIds,
          targetRequirementIds: artifact.targetRequirementIds,
          scores: artifact.scores,
          status: artifact.status,
          enhancement: artifact.metadata?.enhancement ?? null,
        },
        evidenceChain: chain
          ? {
            summary: chain.summary,
            risk: chain.risk,
            sourceEvidences: chain.sourceEvidences.map((evidence) => ({
              id: evidence.id,
              evidenceType: evidence.evidenceType,
              excerpt: evidence.excerpt,
              confidence: evidence.confidence,
            })),
          }
          : null,
      };
    }), null, 2),
    "",
    "Coverage report:",
    JSON.stringify({
      summary: input.coverageReport.summary,
      totalRequirements: input.coverageReport.totalRequirements,
      coveredRequirementIds: input.coverageReport.coveredRequirementIds,
      weaklyCoveredRequirementIds: input.coverageReport.weaklyCoveredRequirementIds,
      noEvidenceRequirementIds: input.coverageReport.noEvidenceRequirementIds,
      notTargetedRequirementIds: input.coverageReport.notTargetedRequirementIds,
    }, null, 2),
    "",
    "Review every artifact exactly once. Do not omit artifacts.",
  ].join("\n");
}

export function buildLLMArtifactCritiqueRepairPrompt(input: {
  invalidResponse: string;
  parseError: string;
}): string {
  return [
    "Convert the invalid artifact critique response into valid JSON matching the requested schema.",
    "Return one critique item for every artifact. Return JSON only.",
    "",
    `Parse error: ${input.parseError}`,
    "",
    "Invalid response:",
    input.invalidResponse.slice(0, 2_000),
  ].join("\n");
}
