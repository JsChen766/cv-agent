import type { JDRequirement, RequirementQueryPlan, RetrievalStrictness } from "./types.js";
import {
  canonicalTerm,
  expandDomainTerms,
  extractKeyPhrases,
  extractKeywords,
  isGenericEvidenceTerm,
  termWeight,
  unique,
} from "./textUtils.js";

export class RequirementQueryPlanner {
  public enrich(requirements: Array<Omit<JDRequirement, "retrievalPolicies" | "keywords" | "coreTerms" | "queryVariants" | "strictness"> & {
    retrievalPolicies: JDRequirement["retrievalPolicies"];
  }>): JDRequirement[] {
    return requirements.map((requirement, index) => {
      const plan = this.planOne({
        ...requirement,
        id: requirement.id || `req-${index + 1}`,
        keywords: [],
        coreTerms: [],
        queryVariants: [],
        strictness: "balanced",
      });
      return {
        ...requirement,
        id: plan.requirementId,
        keywords: plan.expandedTerms.slice(0, 24),
        coreTerms: plan.coreTerms,
        queryVariants: unique([requirement.text, ...plan.phrases, plan.expandedTerms.join(" ")]).slice(0, 8),
        strictness: plan.strictness,
      };
    });
  }

  public buildPlans(requirements: JDRequirement[]): RequirementQueryPlan[] {
    return requirements.map((requirement) => this.planOne(requirement));
  }

  private planOne(requirement: JDRequirement): RequirementQueryPlan {
    const extracted = extractKeywords(requirement.text, 28);
    const aliases = expandDomainTerms(requirement.text);
    const terms = unique([...requirement.keywords, ...extracted, ...aliases])
      .filter((term) => !isGenericEvidenceTerm(term))
      .sort((a, b) => termWeight(b) - termWeight(a));
    const coreTerms = unique([
      ...requirement.coreTerms,
      ...terms.filter((term) => termWeight(term) >= 1.2),
      ...aliases.map(canonicalTerm),
    ]).slice(0, 12);
    const phrases = unique([
      ...extractKeyPhrases(requirement.text, 10),
      ...requirement.queryVariants.filter((item) => item.includes(" ") && item.length <= 100),
    ]).slice(0, 12);
    const strictness = requirement.strictness || inferStrictness(requirement);
    return {
      requirementId: requirement.id,
      originalText: requirement.text,
      coreTerms,
      expandedTerms: unique([...coreTerms, ...terms]).slice(0, 32),
      phrases,
      policies: requirement.retrievalPolicies,
      strictness,
    };
  }
}

function inferStrictness(requirement: JDRequirement): RetrievalStrictness {
  if (
    requirement.evidenceType === "need_user_confirmation"
    || requirement.retrievalPolicies.includes("ask_user_required")
    || requirement.retrievalPolicies.includes("claim_verification")
  ) return "strict";
  if (requirement.importance === "low" || requirement.category === "nice_to_have") return "exploratory";
  return "balanced";
}
