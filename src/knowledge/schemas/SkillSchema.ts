import { z } from "zod";
import type { Skill, SkillCategory } from "../types.js";

export const SkillCategorySchema = z.enum([
  "technical",
  "domain",
  "soft",
]) satisfies z.ZodType<SkillCategory>;

export const SkillSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  category: SkillCategorySchema,
  evidenceIds: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<Skill>;
