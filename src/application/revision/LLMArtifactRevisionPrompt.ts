import type { ArtifactRevisionInput } from "./types.js";

export function buildLLMArtifactRevisionSystemPrompt(): string {
  return [
    "You are an evidence-aware ArtifactRevisionAgent.",
    "Your job is to revise one resume artifact using the critique item, evidence chain, user instruction, and optional user confirmations.",
    "Preserve evidence boundaries. Do not invent unsupported facts.",
    "Every revised artifact must include sourceExperienceIds, sourceEvidenceIds, and enhancement claim analysis.",
    "Each claim must have supportLevel and riskLevel.",
    "Do not mark unsupported high-risk claims as ready.",
    "Numbers or metrics absent from cited evidence must stay needs_user_confirmation or unsupported unless the user confirmation explicitly provides them.",
    "If user confirmations support a metric, record it through claim support and the caller will store confirmation metadata.",
    "Return JSON only.",
    "",
    "Return exactly this JSON shape:",
    "{",
    '  "content": "revised bullet",',
    '  "sourceExperienceIds": ["exp-id"],',
    '  "sourceEvidenceIds": ["ev-id"],',
    '  "targetRequirementIds": ["req-id"],',
    '  "claims": [{',
    '    "text": "claim text",',
    '    "supportLevel": "supported | inferred | needs_user_confirmation | unsupported",',
    '    "riskLevel": "low | medium | high",',
    '    "evidenceIds": ["ev-id"],',
    '    "sourceExperienceIds": ["exp-id"],',
    '    "userConfirmationPrompt": "optional question"',
    "  }],",
    '  "status": "ready | needs_confirmation | unsafe",',
    '  "confirmationQuestions": ["string"],',
    '  "enhancementStrategy": "evidence_rewrite | reasonable_inference | confirmation_needed | unsafe_candidate",',
    '  "rationale": "string",',
    '  "warnings": ["string"]',
    "}",
  ].join("\n");
}

export function buildLLMArtifactRevisionUserPrompt(input: ArtifactRevisionInput): string {
  return [
    `userId: ${input.userId}`,
    `jdId: ${input.jdId ?? input.artifact.targetJDId}`,
    `instruction: ${input.instruction}`,
    input.customInstruction ? `customInstruction: ${input.customInstruction}` : "",
    input.tone ? `tone: ${input.tone}` : "",
    "",
    "Original artifact:",
    JSON.stringify({
      id: input.artifact.id,
      content: input.artifact.content,
      type: input.artifact.type,
      sourceExperienceIds: input.artifact.sourceExperienceIds,
      sourceEvidenceIds: input.artifact.sourceEvidenceIds,
      targetRequirementIds: input.artifact.targetRequirementIds,
      targetRole: input.artifact.targetRole,
      scores: input.artifact.scores,
      status: input.artifact.status,
      enhancement: input.artifact.metadata?.enhancement ?? null,
    }, null, 2),
    "",
    "Critique item:",
    JSON.stringify(input.critiqueItem ?? null, null, 2),
    "",
    "Evidence chain:",
    JSON.stringify(input.evidenceChain
      ? {
        id: input.evidenceChain.id,
        summary: input.evidenceChain.summary,
        risk: input.evidenceChain.risk,
        sourceExperiences: input.evidenceChain.sourceExperiences.map((experience) => ({
          id: experience.id,
          role: experience.role,
          organization: experience.organization,
          summary: experience.summary,
        })),
        sourceEvidences: input.evidenceChain.sourceEvidences.map((evidence) => ({
          id: evidence.id,
          experienceId: evidence.experienceId,
          evidenceType: evidence.evidenceType,
          excerpt: evidence.excerpt,
          confidence: evidence.confidence,
        })),
      }
      : null, null, 2),
    "",
    "User confirmations:",
    JSON.stringify(input.userConfirmations ?? [], null, 2),
    "",
    "Target requirement override:",
    JSON.stringify(input.targetRequirementIds ?? [], null, 2),
    "",
    "Revise the artifact once. Do not return multiple alternatives.",
  ].filter(Boolean).join("\n");
}

export function buildLLMArtifactRevisionRepairPrompt(input: {
  invalidResponse: string;
  parseError: string;
}): string {
  return [
    "Convert the invalid artifact revision response into valid JSON matching the requested schema.",
    "Preserve source ids from the original/evidence chain only. Return JSON only.",
    "",
    `Parse error: ${input.parseError}`,
    "",
    "Invalid response:",
    input.invalidResponse.slice(0, 2_000),
  ].join("\n");
}
