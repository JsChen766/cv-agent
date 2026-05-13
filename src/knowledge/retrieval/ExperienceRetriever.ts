import type {
  Evidence,
  Experience,
  JDRequirement,
  Skill,
} from "../types.js";
import type {
  EvidenceRepository,
  ExperienceRepository,
  SkillRepository,
} from "../repositories.js";
import { tokenize } from "../keywordUtils.js";

export type RetrieveExperiencesInput = {
  userId: string;
  requirements: JDRequirement[];
  limit?: number;
};

export type RetrievedExperience = {
  experience: Experience;
  evidences: Evidence[];
  skills: Skill[];
  matchedEvidences: Evidence[];
  matchedSkills: Skill[];
  matchedRequirements: JDRequirement[];
  matchScore: number;
  matchedRequirementIds: string[];
  matchedEvidenceIds: string[];
  matchedSkillIds: string[];
  reason: string;
};

export interface ExperienceRetriever {
  retrieve(input: RetrieveExperiencesInput): Promise<RetrievedExperience[]>;
}

export class KeywordExperienceRetriever implements ExperienceRetriever {
  constructor(
    private readonly experienceRepo: ExperienceRepository,
    private readonly evidenceRepo: EvidenceRepository,
    private readonly skillRepo: SkillRepository,
  ) {}

  async retrieve(input: RetrieveExperiencesInput): Promise<RetrievedExperience[]> {
    const [experiences, userSkills] = await Promise.all([
      this.experienceRepo.listByUserId(input.userId),
      this.skillRepo.listByUserId(input.userId),
    ]);
    const skillById = new Map(userSkills.map((skill) => [skill.id, skill]));

    const retrieved = await Promise.all(
      experiences.map(async (experience) =>
        this.scoreExperience(experience, input.requirements, skillById),
      ),
    );

    return retrieved
      .filter((result) => result.matchScore > 0)
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, input.limit ?? 5);
  }

  private async scoreExperience(
    experience: Experience,
    requirements: JDRequirement[],
    skillById: Map<string, Skill>,
  ): Promise<RetrievedExperience> {
    const evidences = await this.evidenceRepo.getByExperienceId(experience.id);
    const experienceText = [
      experience.summary,
      experience.star.situation,
      experience.star.task,
      experience.star.action,
      experience.star.result,
      ...evidences.map((e) => e.excerpt),
      ...experience.skillIds.map((id) => skillById.get(id)?.name ?? ""),
    ].join(" ");

    const matchedEvidenceIds = new Set<string>();
    const matchedSkillIds = new Set<string>();
    const matchedRequirementIds = new Set<string>();
    let weightedScore = 0;
    let totalWeight = 0;

    for (const requirement of requirements) {
      const requiredSkills = requirement.requiredSkillIds;
      const directSkillMatches = requiredSkills.filter((id) =>
        experience.skillIds.includes(id),
      );
      const skillNameMatches = requiredSkills.filter((id) => {
        const skill = skillById.get(id);
        return skill ? includesWord(experienceText, skill.name) : false;
      });
      for (const id of [...directSkillMatches, ...skillNameMatches]) {
        matchedSkillIds.add(id);
        for (const evidenceId of skillById.get(id)?.evidenceIds ?? []) {
          if (experience.evidenceIds.includes(evidenceId)) {
            matchedEvidenceIds.add(evidenceId);
          }
        }
      }

      const requirementTokens = tokenize(requirement.description);
      const textTokens = tokenize(experienceText);
      const keywordMatches = requirementTokens.filter((token) =>
        textTokens.includes(token),
      );

      for (const evidence of evidences) {
        if (
          keywordMatches.some((token) => includesWord(evidence.excerpt, token)) ||
          Array.from(matchedSkillIds).some((id) => {
            const skill = skillById.get(id);
            return skill ? includesWord(evidence.excerpt, skill.name) : false;
          })
        ) {
          matchedEvidenceIds.add(evidence.id);
        }
      }

      const skillScore =
        requiredSkills.length === 0
          ? 0
          : directSkillMatches.length / requiredSkills.length;
      const keywordScore =
        requirementTokens.length === 0
          ? 0
          : keywordMatches.length / requirementTokens.length;
      const score = skillScore * 0.65 + keywordScore * 0.35;

      if (score > 0) {
        matchedRequirementIds.add(requirement.id);
      }
      weightedScore += score * requirement.weight;
      totalWeight += requirement.weight;
    }

    const matchScore =
      totalWeight === 0 ? 0 : Number((weightedScore / totalWeight).toFixed(3));
    const skills = experience.skillIds
      .map((id) => skillById.get(id))
      .filter(Boolean) as Skill[];
    const matchedEvidences = evidences.filter((evidence) =>
      matchedEvidenceIds.has(evidence.id),
    );
    const matchedSkills = Array.from(matchedSkillIds)
      .map((id) => skillById.get(id))
      .filter(Boolean) as Skill[];
    const matchedRequirements = requirements.filter((requirement) =>
      matchedRequirementIds.has(requirement.id),
    );
    const reason = this.buildReason(matchedSkills, matchedEvidences);

    return {
      experience,
      evidences,
      skills,
      matchedEvidences,
      matchedSkills,
      matchedRequirements,
      matchScore,
      matchedRequirementIds: Array.from(matchedRequirementIds),
      matchedEvidenceIds: Array.from(matchedEvidenceIds),
      matchedSkillIds: Array.from(matchedSkillIds),
      reason,
    };
  }

  private buildReason(
    matchedSkills: Skill[],
    matchedEvidences: Evidence[],
  ): string {
    const skillNames = matchedSkills.map((skill) => skill.name);
    return `Matched ${skillNames.join(", ") || "keywords"} with ${matchedEvidences.length} supporting evidence item(s).`;
  }
}

function includesWord(text: string, word: string): boolean {
  return text.toLowerCase().includes(word.toLowerCase());
}
