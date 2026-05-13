import type {
  Evidence,
  EvidenceChain,
  Experience,
  ExperienceVariant,
  GeneratedArtifact,
  GraphView,
  JDRequirement,
  Skill,
} from "../types.js";
import { EvidenceSchema } from "./EvidenceSchema.js";
import { ExperienceSchema } from "./ExperienceSchema.js";
import { ExperienceVariantSchema } from "./ExperienceVariantSchema.js";
import { GeneratedArtifactSchema } from "./GeneratedArtifactSchema.js";
import { EvidenceChainSchema } from "./EvidenceChainSchema.js";
import { GraphViewSchema } from "./GraphViewSchema.js";
import { JDRequirementSchema } from "./JDRequirementSchema.js";
import { SkillSchema } from "./SkillSchema.js";
import { parseWithSchema } from "./validate.js";

export * from "./ExperienceSchema.js";
export * from "./EvidenceSchema.js";
export * from "./SkillSchema.js";
export * from "./JDRequirementSchema.js";
export * from "./ExperienceVariantSchema.js";
export * from "./GeneratedArtifactSchema.js";
export * from "./EvidenceChainSchema.js";
export * from "./GraphViewSchema.js";
export * from "./validate.js";

export function validateExperience(input: unknown): Experience {
  return parseWithSchema(ExperienceSchema, input, "Experience");
}

export function validateEvidence(input: unknown): Evidence {
  return parseWithSchema(EvidenceSchema, input, "Evidence");
}

export function validateSkill(input: unknown): Skill {
  return parseWithSchema(SkillSchema, input, "Skill");
}

export function validateJDRequirement(input: unknown): JDRequirement {
  return parseWithSchema(JDRequirementSchema, input, "JDRequirement");
}

export function validateExperienceVariant(input: unknown): ExperienceVariant {
  return parseWithSchema(ExperienceVariantSchema, input, "ExperienceVariant");
}

export function validateGeneratedArtifact(input: unknown): GeneratedArtifact {
  return parseWithSchema(GeneratedArtifactSchema, input, "GeneratedArtifact");
}

export function validateEvidenceChain(input: unknown): EvidenceChain {
  return parseWithSchema(EvidenceChainSchema, input, "EvidenceChain");
}

export function validateGraphView(input: unknown): GraphView {
  return parseWithSchema(GraphViewSchema, input, "GraphView");
}
