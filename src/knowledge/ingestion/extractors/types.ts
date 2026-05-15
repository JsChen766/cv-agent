import { z } from "zod";
import type { ExperienceType, SkillCategory } from "../../types.js";
import type { IngestExperienceInput } from "../ExperienceIngestionService.js";

export type ExtractedSkill = {
  name: string;
  category?: SkillCategory;
};

// Reuse the ExtractedExperience type definition here since it's shared
export type ExtractedExperience = {
  type: ExperienceType;
  organization: string;
  role: string;
  summary: string;
  evidenceExcerpts: string[];
  skillNames?: ExtractedSkill[];
  warnings?: string[];
  metadata?: Record<string, unknown>;
};

export interface ExperienceExtractor {
  extract(input: IngestExperienceInput): Promise<ExtractedExperience>;
}

// Agent-output zod schema for validating JSON from AgentExperienceExtractor
export const AgentExtractedExperienceSchema = z.object({
  type: z.enum(["work", "project", "education", "volunteer", "other"]),
  organization: z.string(),
  role: z.string(),
  summary: z.string(),
  evidenceExcerpts: z.array(z.string()),
});
