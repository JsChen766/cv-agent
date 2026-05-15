import type { GenerateArtifactsInput } from "./ArtifactGenerator.js";

export function buildLLMArtifactGenerationSystemPrompt(): string {
  return [
    "You are an evidence-aware resume artifact generator.",
    "Your job is to enhance resume bullets while respecting evidence boundaries.",
    "You may strengthen wording, make reasonable inferences, and suggest quantification candidates.",
    "You must classify each claim into supported, inferred, needs_user_confirmation, or unsupported.",
    "Do not present unsupported high-risk claims as ready-to-use facts.",
    "Ready bullets may include supported claims and low-risk inferred claims.",
    "Bullets with numbers, percentages, currency, or counts not present in evidence must be needs_confirmation unless clearly supported.",
    "Unsafe candidates must be marked unsafe and should not be used directly.",
    "Every bullet must include sourceExperienceIds and sourceEvidenceIds from the provided evidence pack.",
    "Return JSON only.",
    "",
    "Return exactly this JSON shape:",
    "{",
    '  "artifacts": [',
    "    {",
    '      "content": "resume bullet text",',
    '      "targetRequirementIds": ["req-id"],',
    '      "sourceExperienceIds": ["exp-id"],',
    '      "sourceEvidenceIds": ["ev-id"],',
    '      "claims": [{',
    '        "text": "claim text",',
    '        "supportLevel": "supported | inferred | needs_user_confirmation | unsupported",',
    '        "riskLevel": "low | medium | high",',
    '        "evidenceIds": ["ev-id"],',
    '        "sourceExperienceIds": ["exp-id"],',
    '        "userConfirmationPrompt": "optional question"',
    "      }],",
    '      "status": "ready | needs_confirmation | unsafe",',
    '      "confirmationQuestions": ["question"],',
    '      "enhancementStrategy": "evidence_rewrite | reasonable_inference | confirmation_needed | unsafe_candidate",',
    '      "rationale": "optional short rationale"',
    "    }",
    "  ],",
    '  "warnings": ["string"]',
    "}",
  ].join("\n");
}

export function buildLLMArtifactGenerationUserPrompt(input: GenerateArtifactsInput): string {
  const experiences = input.experiences ?? input.retrievedExperiences.map((retrieved) => retrieved.experience);
  const evidences = input.evidences ?? uniqueById(input.retrievedExperiences.flatMap((retrieved) => [
    ...retrieved.evidences,
    ...retrieved.matchedEvidences,
  ]));
  const skills = input.skills ?? uniqueById(input.retrievedExperiences.flatMap((retrieved) => [
    ...retrieved.skills,
    ...retrieved.matchedSkills,
  ]));
  return [
    `Target role: ${input.targetRole}`,
    "",
    "Job description:",
    input.jdText.slice(0, 4_000),
    "",
    "Requirements:",
    JSON.stringify(input.requirements.map((requirement) => ({
      id: requirement.id,
      text: requirement.description,
      requiredSkillIds: requirement.requiredSkillIds,
      weight: requirement.weight,
    })), null, 2),
    "",
    "Evidence pack:",
    JSON.stringify({
      experiences: experiences.map((experience) => ({
        id: experience.id,
        role: experience.role,
        organization: experience.organization,
        summary: experience.summary,
        evidenceIds: experience.evidenceIds,
        skillIds: experience.skillIds,
      })),
      evidences: evidences.map((evidence) => ({
        id: evidence.id,
        experienceId: evidence.experienceId,
        excerpt: evidence.excerpt,
        evidenceType: evidence.evidenceType,
        confidence: evidence.confidence,
      })),
      skills: skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        category: skill.category,
      })),
    }, null, 2),
    "",
    "Generate 1-3 resume bullets. Prefer ready bullets when supported by evidence.",
    "If a stronger metric would improve the bullet but is not in evidence, create a needs_confirmation artifact with a confirmation question.",
    "Use only IDs from the evidence pack and requirements.",
  ].join("\n");
}

export function buildLLMArtifactGenerationRepairPrompt(input: {
  invalidResponse: string;
  parseError: string;
}): string {
  return [
    "Convert the invalid artifact generation response into valid JSON matching the requested schema.",
    "Preserve only claims supported by the provided IDs.",
    "Return JSON only.",
    "",
    `Parse error: ${input.parseError}`,
    "",
    "Invalid response:",
    input.invalidResponse.slice(0, 2_000),
  ].join("\n");
}

function uniqueById<TItem extends { id: string }>(items: TItem[]): TItem[] {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}
