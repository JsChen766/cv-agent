import type { ProductExperienceSummary } from "../../product/types.js";
import type { ExperienceService } from "../../product/services/index.js";
import type { EvidenceRAGExperience, JDRequirement, RetrievedExperience } from "./types.js";
import { clamp, scoreTextOverlap, stringifyStructured, unique } from "./textUtils.js";

export class ExperienceRetriever {
  public constructor(private readonly experienceService: ExperienceService) {}

  public async retrieve(input: {
    userId: string;
    requirements: JDRequirement[];
    limit?: number;
  }): Promise<RetrievedExperience[]> {
    const experiences = await this.experienceService.listExperiences(input.userId, { limit: 100, status: "active" });
    const scored = experiences.map((experience) => this.scoreExperience(experience as EvidenceRAGExperience, input.requirements));
    return scored
      .filter((item) => item.score > 0 || item.experience.content?.trim())
      .sort((a, b) => b.score - a.score || b.matchedTerms.length - a.matchedTerms.length)
      .slice(0, input.limit ?? 12);
  }

  private scoreExperience(experience: ProductExperienceSummary & { tags?: string[]; content?: string; structured?: Record<string, unknown> }, requirements: JDRequirement[]): RetrievedExperience {
    const searchable = [
      experience.title,
      experience.organization,
      experience.role,
      experience.category,
      experience.content,
      ...(experience.tags ?? []),
      stringifyStructured(experience.structured),
    ].filter(Boolean).join("\n");

    let rawScore = 0;
    const matchedTerms: string[] = [];
    const matchedRequirementIds: string[] = [];
    for (const requirement of requirements) {
      const { score, matchedTerms: terms } = scoreTextOverlap(requirement.keywords.length > 0 ? requirement.keywords : [requirement.text], searchable);
      if (score > 0) {
        rawScore += score * importanceWeight(requirement.importance) * policyWeight(requirement.retrievalPolicies);
        matchedRequirementIds.push(requirement.id);
        matchedTerms.push(...terms);
      }
    }

    const contentBonus = experience.content && experience.content.trim().length > 60 ? 0.08 : 0;
    const structuredBonus = experience.structured && Object.keys(experience.structured).length > 0 ? 0.06 : 0;
    const score = clamp(rawScore / Math.max(1, requirements.length) + contentBonus + structuredBonus);
    const uniqueTerms = unique(matchedTerms).slice(0, 16);
    return {
      experience,
      score,
      matchedTerms: uniqueTerms,
      matchedRequirementIds: unique(matchedRequirementIds),
      reason: uniqueTerms.length > 0
        ? `Matched JD terms: ${uniqueTerms.slice(0, 8).join(", ")}`
        : "Included as available experience evidence.",
    };
  }
}

function importanceWeight(value: JDRequirement["importance"]): number {
  if (value === "critical") return 1.25;
  if (value === "high") return 1.1;
  if (value === "low") return 0.7;
  return 1;
}

function policyWeight(policies: JDRequirement["retrievalPolicies"]): number {
  if (policies.includes("keyword_exact") || policies.includes("structured_skill")) return 1.15;
  if (policies.includes("claim_verification")) return 1.05;
  return 1;
}
