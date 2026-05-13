import type {
  ArtifactScores,
  Evidence,
  EvidenceChain,
  Experience,
  GeneratedArtifact,
  JDRequirement,
  Skill,
} from "./types.js";

const EXPERIENCE_TYPES = ["work", "project", "education", "volunteer", "other"];
const EVIDENCE_SOURCE_TYPES = [
  "raw_input",
  "resume",
  "interview_note",
  "portfolio",
  "manual",
];
const EVIDENCE_TYPES = ["bullet", "metric", "project", "skill", "outcome"];
const SKILL_CATEGORIES = ["technical", "domain", "soft"];
const ARTIFACT_TYPES = [
  "resume_bullet",
  "resume_summary",
  "cover_letter_snippet",
];
const ARTIFACT_STATUSES = ["draft", "ready", "needs_review"];
const RISK_LEVELS = ["low", "medium", "high"];

export type Schema<T> = {
  parse(value: unknown): T;
  is(value: unknown): value is T;
};

export const ExperienceSchema = createSchema<Experience>(
  "Experience",
  assertExperience,
);
export const EvidenceSchema = createSchema<Evidence>("Evidence", assertEvidence);
export const SkillSchema = createSchema<Skill>("Skill", assertSkill);
export const JDRequirementSchema = createSchema<JDRequirement>(
  "JDRequirement",
  assertJDRequirement,
);
export const GeneratedArtifactSchema = createSchema<GeneratedArtifact>(
  "GeneratedArtifact",
  assertGeneratedArtifact,
);
export const EvidenceChainSchema = createSchema<EvidenceChain>(
  "EvidenceChain",
  assertEvidenceChain,
);

export function validateExperience(value: unknown): Experience {
  return ExperienceSchema.parse(value);
}

export function validateEvidence(value: unknown): Evidence {
  return EvidenceSchema.parse(value);
}

export function validateSkill(value: unknown): Skill {
  return SkillSchema.parse(value);
}

export function validateJDRequirement(value: unknown): JDRequirement {
  return JDRequirementSchema.parse(value);
}

export function validateGeneratedArtifact(value: unknown): GeneratedArtifact {
  return GeneratedArtifactSchema.parse(value);
}

export function validateEvidenceChain(value: unknown): EvidenceChain {
  return EvidenceChainSchema.parse(value);
}

function createSchema<T>(
  name: string,
  assertFn: (value: unknown, path: string) => asserts value is T,
): Schema<T> {
  return {
    parse(value: unknown): T {
      assertFn(value, name);
      return value;
    },
    is(value: unknown): value is T {
      try {
        assertFn(value, name);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function assertExperience(value: unknown, path: string): asserts value is Experience {
  assertObject(value, path);
  assertString(value.id, `${path}.id`);
  assertString(value.userId, `${path}.userId`);
  assertEnum(value.type, EXPERIENCE_TYPES, `${path}.type`);
  assertString(value.organization, `${path}.organization`);
  assertString(value.role, `${path}.role`);
  assertString(value.summary, `${path}.summary`);
  assertObject(value.timeRange, `${path}.timeRange`);
  assertNullableString(value.timeRange.startDate, `${path}.timeRange.startDate`);
  assertNullableString(value.timeRange.endDate, `${path}.timeRange.endDate`);
  assertObject(value.star, `${path}.star`);
  assertString(value.star.situation, `${path}.star.situation`);
  assertString(value.star.task, `${path}.star.task`);
  assertString(value.star.action, `${path}.star.action`);
  assertString(value.star.result, `${path}.star.result`);
  assertStringArray(value.evidenceIds, `${path}.evidenceIds`);
  assertStringArray(value.skillIds, `${path}.skillIds`);
  assertNumber(value.confidence, `${path}.confidence`);
  assertString(value.createdAt, `${path}.createdAt`);
  assertString(value.updatedAt, `${path}.updatedAt`);
}

function assertEvidence(value: unknown, path: string): asserts value is Evidence {
  assertObject(value, path);
  assertString(value.id, `${path}.id`);
  assertString(value.userId, `${path}.userId`);
  assertString(value.experienceId, `${path}.experienceId`);
  assertEnum(value.sourceType, EVIDENCE_SOURCE_TYPES, `${path}.sourceType`);
  assertEnum(value.evidenceType, EVIDENCE_TYPES, `${path}.evidenceType`);
  assertString(value.sourceRef, `${path}.sourceRef`);
  assertString(value.excerpt, `${path}.excerpt`);
  assertNumber(value.confidence, `${path}.confidence`);
  assertString(value.createdAt, `${path}.createdAt`);
}

function assertSkill(value: unknown, path: string): asserts value is Skill {
  assertObject(value, path);
  assertString(value.id, `${path}.id`);
  assertString(value.userId, `${path}.userId`);
  assertString(value.name, `${path}.name`);
  assertEnum(value.category, SKILL_CATEGORIES, `${path}.category`);
  assertStringArray(value.evidenceIds, `${path}.evidenceIds`);
  assertString(value.createdAt, `${path}.createdAt`);
  assertString(value.updatedAt, `${path}.updatedAt`);
}

function assertJDRequirement(
  value: unknown,
  path: string,
): asserts value is JDRequirement {
  assertObject(value, path);
  assertString(value.id, `${path}.id`);
  assertString(value.userId, `${path}.userId`);
  assertString(value.jdId, `${path}.jdId`);
  assertString(value.description, `${path}.description`);
  assertStringArray(value.requiredSkillIds, `${path}.requiredSkillIds`);
  assertNumber(value.weight, `${path}.weight`);
  assertString(value.createdAt, `${path}.createdAt`);
}

function assertGeneratedArtifact(
  value: unknown,
  path: string,
): asserts value is GeneratedArtifact {
  assertObject(value, path);
  assertString(value.id, `${path}.id`);
  assertString(value.userId, `${path}.userId`);
  assertEnum(value.type, ARTIFACT_TYPES, `${path}.type`);
  assertString(value.content, `${path}.content`);
  assertStringArray(value.sourceExperienceIds, `${path}.sourceExperienceIds`);
  assertStringArray(value.sourceEvidenceIds, `${path}.sourceEvidenceIds`);
  assertStringArray(value.matchedSkillIds, `${path}.matchedSkillIds`);
  assertString(value.targetJDId, `${path}.targetJDId`);
  assertStringArray(value.targetRequirementIds, `${path}.targetRequirementIds`);
  assertString(value.targetRole, `${path}.targetRole`);
  assertArtifactScores(value.scores, `${path}.scores`);
  assertEnum(value.status, ARTIFACT_STATUSES, `${path}.status`);
  assertString(value.createdAt, `${path}.createdAt`);
  assertString(value.updatedAt, `${path}.updatedAt`);
}

function assertEvidenceChain(
  value: unknown,
  path: string,
): asserts value is EvidenceChain {
  assertObject(value, path);
  assertString(value.id, `${path}.id`);
  assertGeneratedArtifact(value.artifact, `${path}.artifact`);
  assertString(value.summary, `${path}.summary`);
  assertArray(value.requirementMatches, `${path}.requirementMatches`);
  for (const [index, match] of value.requirementMatches.entries()) {
    assertObject(match, `${path}.requirementMatches[${index}]`);
    assertJDRequirement(match.requirement, `${path}.requirementMatches[${index}].requirement`);
    assertArray(match.matchedSkills, `${path}.requirementMatches[${index}].matchedSkills`);
    for (const [skillIndex, skill] of match.matchedSkills.entries()) {
      assertSkill(skill, `${path}.requirementMatches[${index}].matchedSkills[${skillIndex}]`);
    }
    assertArray(match.matchedExperiences, `${path}.requirementMatches[${index}].matchedExperiences`);
    for (const [experienceIndex, experience] of match.matchedExperiences.entries()) {
      assertExperience(experience, `${path}.requirementMatches[${index}].matchedExperiences[${experienceIndex}]`);
    }
    assertArray(match.matchedEvidences, `${path}.requirementMatches[${index}].matchedEvidences`);
    for (const [evidenceIndex, evidence] of match.matchedEvidences.entries()) {
      assertEvidence(evidence, `${path}.requirementMatches[${index}].matchedEvidences[${evidenceIndex}]`);
    }
    assertNumber(match.matchScore, `${path}.requirementMatches[${index}].matchScore`);
    assertString(match.matchReason, `${path}.requirementMatches[${index}].matchReason`);
  }
  assertArray(value.sourceExperiences, `${path}.sourceExperiences`);
  for (const [index, experience] of value.sourceExperiences.entries()) {
    assertExperience(experience, `${path}.sourceExperiences[${index}]`);
  }
  assertArray(value.sourceEvidences, `${path}.sourceEvidences`);
  for (const [index, evidence] of value.sourceEvidences.entries()) {
    assertEvidence(evidence, `${path}.sourceEvidences[${index}]`);
  }
  assertArray(value.sourceSkills, `${path}.sourceSkills`);
  for (const [index, skill] of value.sourceSkills.entries()) {
    assertSkill(skill, `${path}.sourceSkills[${index}]`);
  }
  assertObject(value.risk, `${path}.risk`);
  assertEnum(value.risk.level, RISK_LEVELS, `${path}.risk.level`);
  assertEnum(value.risk.truthfulnessRisk, RISK_LEVELS, `${path}.risk.truthfulnessRisk`);
  assertEnum(value.risk.exaggerationRisk, RISK_LEVELS, `${path}.risk.exaggerationRisk`);
  assertStringArray(value.risk.missingEvidenceClaims, `${path}.risk.missingEvidenceClaims`);
  assertStringArray(value.risk.exaggerationWarnings, `${path}.risk.exaggerationWarnings`);
  assertStringArray(value.risk.notes, `${path}.risk.notes`);
  assertArtifactScores(value.scores, `${path}.scores`);
  assertString(value.createdAt, `${path}.createdAt`);
}

function assertArtifactScores(
  value: unknown,
  path: string,
): asserts value is ArtifactScores {
  assertObject(value, path);
  assertNumber(value.overall, `${path}.overall`);
  assertNumber(value.requirementMatch, `${path}.requirementMatch`);
  assertNumber(value.evidenceStrength, `${path}.evidenceStrength`);
}

function assertObject(
  value: unknown,
  path: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
}

function assertArray(value: unknown, path: string): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }
}

function assertEnum(
  value: unknown,
  allowed: string[],
  path: string,
): asserts value is string {
  assertString(value, path);
  if (!allowed.includes(value)) {
    throw new Error(`${path} must be one of: ${allowed.join(", ")}.`);
  }
}

function assertNullableString(
  value: unknown,
  path: string,
): asserts value is string | null {
  if (value !== null && typeof value !== "string") {
    throw new Error(`${path} must be a string or null.`);
  }
}

function assertNumber(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`${path} must be a number.`);
  }
}

function assertStringArray(
  value: unknown,
  path: string,
): asserts value is string[] {
  assertArray(value, path);
  for (const [index, item] of value.entries()) {
    assertString(item, `${path}[${index}]`);
  }
}
