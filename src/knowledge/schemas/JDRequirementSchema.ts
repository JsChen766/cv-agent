import { z } from "zod";
import type { JDRequirement } from "../types.js";

export const JDRequirementSchema = z.object({
  id: z.string(),
  userId: z.string(),
  jdId: z.string(),
  description: z.string(),
  requiredSkillIds: z.array(z.string()),
  weight: z.number(),
  createdAt: z.string(),
}) satisfies z.ZodType<JDRequirement>;
