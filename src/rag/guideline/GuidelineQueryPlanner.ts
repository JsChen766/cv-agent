import type { GuidelineQueryPlan, GuidelineRoleAnalysis, GuidelineSourceType } from "./types.js";
import { unique } from "./textUtils.js";

export class GuidelineQueryPlanner {
  public plan(analysis: GuidelineRoleAnalysis): GuidelineQueryPlan {
    const sourceQuotas: Partial<Record<GuidelineSourceType, number>> = {
      rule: 5,
      role_template: 4,
      example_resume: 3,
      school_template: analysis.applicationType === "school" || analysis.applicationType === "research" ? 3 : 1,
    };
    return {
      roleFamilies: unique([analysis.roleFamily, ...analysis.secondaryRoleFamilies]),
      applicationType: analysis.applicationType,
      language: analysis.language,
      mandatoryTags: ["truth", "evidence", "no fabrication", "factual boundary"],
      preferredTags: unique([
        analysis.roleFamily,
        analysis.applicationType,
        ...analysis.emphasisDimensions,
        ...analysis.keywords.slice(0, 25),
      ]),
      queryVariants: unique([
        `${analysis.roleFamily} resume strategy`,
        `${analysis.applicationType} application writing`,
        ...analysis.priorityRequirements.slice(0, 8),
      ]),
      sourceQuotas,
    };
  }
}
