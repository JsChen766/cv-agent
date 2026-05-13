import { z } from "zod";
import type {
  EvidenceChain,
  EvidenceRequirementMatch,
  EvidenceRiskAssessment,
  RiskLevel,
} from "../types.js";
import { EvidenceSchema } from "./EvidenceSchema.js";
import { ExperienceSchema } from "./ExperienceSchema.js";
import { GeneratedArtifactSchema, ArtifactScoresSchema } from "./GeneratedArtifactSchema.js";
import { JDRequirementSchema } from "./JDRequirementSchema.js";
import { SkillSchema } from "./SkillSchema.js";

export const RiskLevelSchema = z.enum([
  "low",
  "medium",
  "high",
]) satisfies z.ZodType<RiskLevel>;

export const EvidenceRiskAssessmentSchema = z.object({
  level: RiskLevelSchema,
  truthfulnessRisk: RiskLevelSchema,
  exaggerationRisk: RiskLevelSchema,
  missingEvidenceClaims: z.array(z.string()),
  exaggerationWarnings: z.array(z.string()),
  notes: z.array(z.string()),
}) satisfies z.ZodType<EvidenceRiskAssessment>;

export const EvidenceRequirementMatchSchema = z.object({
  requirement: JDRequirementSchema,
  matchedSkills: z.array(SkillSchema),
  matchedExperiences: z.array(ExperienceSchema),
  matchedEvidences: z.array(EvidenceSchema),
  matchScore: z.number(),
  matchReason: z.string(),
}) satisfies z.ZodType<EvidenceRequirementMatch>;

export const EvidenceChainSchema = z.object({
  id: z.string(),
  artifact: GeneratedArtifactSchema,
  summary: z.string(),
  requirementMatches: z.array(EvidenceRequirementMatchSchema),
  sourceExperiences: z.array(ExperienceSchema),
  sourceEvidences: z.array(EvidenceSchema),
  sourceSkills: z.array(SkillSchema),
  risk: EvidenceRiskAssessmentSchema,
  scores: ArtifactScoresSchema,
  createdAt: z.string(),
}) satisfies z.ZodType<EvidenceChain>;
