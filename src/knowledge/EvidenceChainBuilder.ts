import type {
  Evidence,
  EvidenceChain,
  EvidenceRequirementMatch,
  EvidenceRiskAssessment,
  Experience,
  GeneratedArtifact,
  JDRequirement,
  RiskLevel,
  Skill,
} from "./types.js";
import type { EvidenceRepository, ExperienceRepository } from "./repositories.js";
import { stableId, tokenize } from "./keywordUtils.js";
import { validateEvidenceChain } from "./schemas/index.js";

export class EvidenceChainBuilder {
  constructor(
    private readonly experienceRepo: ExperienceRepository,
    private readonly evidenceRepo: EvidenceRepository,
  ) {}

  async build(
    artifact: GeneratedArtifact,
    skills: Skill[],
    requirements: JDRequirement[],
  ): Promise<EvidenceChain> {
    const sourceExperiences = await this.loadExperiences(
      artifact.sourceExperienceIds,
    );
    const sourceEvidences = await this.loadEvidences(artifact.sourceEvidenceIds);
    const sourceSkills = skills.filter((skill) =>
      artifact.matchedSkillIds.includes(skill.id),
    );
    const { effectiveRequirements, notes } = this.getEffectiveRequirements(
      artifact,
      requirements,
    );
    const requirementMatches = effectiveRequirements.map((requirement) =>
      this.matchRequirement(
        requirement,
        artifact,
        sourceSkills,
        sourceExperiences,
        sourceEvidences,
      ),
    );

    const chain: EvidenceChain = {
      id: stableId("chain", `${artifact.id}:${artifact.updatedAt}`),
      artifact,
      summary: this.buildSummary(artifact, effectiveRequirements, sourceEvidences),
      requirementMatches,
      sourceExperiences,
      sourceEvidences,
      sourceSkills,
      risk: this.assessRisk(
        artifact,
        requirementMatches,
        sourceExperiences,
        sourceEvidences,
        notes,
      ),
      scores: artifact.scores,
      createdAt: new Date().toISOString(),
    };

    validateEvidenceChain(chain);
    return chain;
  }

  private async loadExperiences(ids: string[]): Promise<Experience[]> {
    const experiences = await Promise.all(
      ids.map((id) => this.experienceRepo.getById(id)),
    );
    return experiences.filter(Boolean) as Experience[];
  }

  private async loadEvidences(ids: string[]): Promise<Evidence[]> {
    const evidences = await Promise.all(
      ids.map((id) => this.evidenceRepo.getById(id)),
    );
    return evidences.filter(Boolean) as Evidence[];
  }

  private matchRequirement(
    requirement: JDRequirement,
    artifact: GeneratedArtifact,
    sourceSkills: Skill[],
    sourceExperiences: Experience[],
    sourceEvidences: Evidence[],
  ): EvidenceRequirementMatch {
    const requirementTokens = tokenize(requirement.description);
    const matchedSkills = sourceSkills.filter(
      (skill) =>
        requirement.requiredSkillIds.includes(skill.id) ||
        requirementTokens.includes(skill.name.toLowerCase()),
    );
    const matchedSkillIds = new Set(matchedSkills.map((skill) => skill.id));
    const matchedEvidenceIds = new Set<string>();

    for (const skill of matchedSkills) {
      for (const evidenceId of skill.evidenceIds) {
        matchedEvidenceIds.add(evidenceId);
      }
    }
    for (const evidence of sourceEvidences) {
      if (
        requirementTokens.some((token) =>
          evidence.excerpt.toLowerCase().includes(token),
        )
      ) {
        matchedEvidenceIds.add(evidence.id);
      }
    }

    const matchedEvidences = sourceEvidences.filter((evidence) =>
      matchedEvidenceIds.has(evidence.id),
    );
    const matchedExperienceIds = new Set(
      matchedEvidences.map((evidence) => evidence.experienceId),
    );
    for (const experience of sourceExperiences) {
      if (experience.skillIds.some((skillId) => matchedSkillIds.has(skillId))) {
        matchedExperienceIds.add(experience.id);
      }
    }
    const matchedExperiences = sourceExperiences.filter((experience) =>
      matchedExperienceIds.has(experience.id),
    );

    const skillScore =
      requirement.requiredSkillIds.length === 0
        ? 0
        : matchedSkills.length / requirement.requiredSkillIds.length;
    const evidenceScore =
      sourceEvidences.length === 0
        ? 0
        : matchedEvidences.length / sourceEvidences.length;
    const matchScore = Number(
      Math.min(1, skillScore * 0.7 + evidenceScore * 0.3).toFixed(3),
    );

    return {
      requirement,
      matchedSkills,
      matchedExperiences,
      matchedEvidences,
      matchScore,
      matchReason: `Matched ${matchedSkills.length} skill(s) and ${matchedEvidences.length} evidence item(s) for this requirement.`,
    };
  }

  private buildSummary(
    artifact: GeneratedArtifact,
    requirements: JDRequirement[],
    sourceEvidences: Evidence[],
  ): string {
    const label = this.artifactTypeLabel(artifact.type);
    const evidenceCount = sourceEvidences.length;
    const requirementCount = requirements.length;
    if (evidenceCount === 0) {
      return `This ${label} needs review because no supporting evidence is linked. It covers ${requirementCount} target requirement${requirementCount === 1 ? "" : "s"}.`;
    }
    return `This ${label} is backed by ${evidenceCount} evidence item${evidenceCount === 1 ? "" : "s"} and covers ${requirementCount} target requirement${requirementCount === 1 ? "" : "s"}.`;
  }

  private assessRisk(
    artifact: GeneratedArtifact,
    requirementMatches: EvidenceRequirementMatch[],
    sourceExperiences: Experience[],
    sourceEvidences: Evidence[],
    initialNotes: string[] = [],
  ): EvidenceRiskAssessment {
    const missingEvidenceClaims: string[] = [];
    const exaggerationWarnings: string[] = [];
    const notes: string[] = [...initialNotes];

    if (sourceExperiences.length === 0) {
      missingEvidenceClaims.push("Generated artifact has no source experience.");
    }
    if (sourceEvidences.length === 0) {
      missingEvidenceClaims.push("Generated artifact has no supporting evidence.");
    }
    for (const match of requirementMatches) {
      if (match.matchedEvidences.length === 0) {
        missingEvidenceClaims.push(
          `No evidence supports requirement: ${match.requirement.description}`,
        );
      }
    }
    if (artifact.scores.evidenceStrength < 0.5) {
      exaggerationWarnings.push("Evidence strength score is below 0.5.");
    }
    for (const number of this.detectUnsupportedNumbers(artifact.content, sourceEvidences)) {
      exaggerationWarnings.push(
        `Artifact includes unsupported number "${number}" that is not present in linked evidence.`,
      );
    }
    for (const phrase of this.detectUnsupportedClaimPhrases(artifact.content, sourceEvidences)) {
      exaggerationWarnings.push(
        `Artifact includes unsupported claim phrase "${phrase}" that is not present in linked evidence.`,
      );
    }
    if (artifact.status === "needs_review") {
      notes.push("Artifact is marked as needs_review.");
    }

    const truthfulnessRisk = this.buildTruthfulnessRisk(
      sourceExperiences,
      sourceEvidences,
      requirementMatches,
    );
    const exaggerationRisk = this.buildExaggerationRisk(
      artifact,
      exaggerationWarnings,
    );
    const level = this.buildRiskLevel(truthfulnessRisk, exaggerationRisk);

    return {
      level,
      truthfulnessRisk,
      exaggerationRisk,
      missingEvidenceClaims,
      exaggerationWarnings,
      notes,
    };
  }

  private getEffectiveRequirements(
    artifact: GeneratedArtifact,
    requirements: JDRequirement[],
  ): { effectiveRequirements: JDRequirement[]; notes: string[] } {
    const notes: string[] = [];
    if (artifact.targetRequirementIds.length === 0) {
      return { effectiveRequirements: requirements, notes };
    }

    const requirementById = new Map(requirements.map((requirement) => [requirement.id, requirement]));
    const effectiveRequirements = artifact.targetRequirementIds
      .map((id) => requirementById.get(id))
      .filter(Boolean) as JDRequirement[];
    const missingIds = artifact.targetRequirementIds.filter((id) => !requirementById.has(id));

    if (missingIds.length > 0) {
      notes.push(`Artifact references unknown target requirement id(s): ${missingIds.join(", ")}.`);
    }

    return {
      effectiveRequirements: effectiveRequirements.length > 0 ? effectiveRequirements : requirements,
      notes,
    };
  }

  private detectUnsupportedNumbers(
    content: string,
    sourceEvidences: Evidence[],
  ): string[] {
    const evidenceText = sourceEvidences.map((evidence) => evidence.excerpt).join(" ");
    const evidenceNumbers = new Set(this.extractNumbers(evidenceText));
    return this.extractNumbers(content).filter((number) => !evidenceNumbers.has(number));
  }

  private detectUnsupportedClaimPhrases(
    content: string,
    sourceEvidences: Evidence[],
  ): string[] {
    const evidenceText = sourceEvidences.map((evidence) => evidence.excerpt).join(" ").toLowerCase();
    const checks: Array<{ pattern: RegExp; phrase: string; evidenceKeywords: string[] }> = [
      { pattern: /\bgather(?:ed)? requirements\b/i, phrase: "gathered requirements", evidenceKeywords: ["requirements"] },
      { pattern: /\balign(?:ed)? stakeholders\b/i, phrase: "aligned stakeholders", evidenceKeywords: ["stakeholders"] },
      { pattern: /\bmentored\b/i, phrase: "mentored", evidenceKeywords: ["mentored", "mentoring"] },
      { pattern: /\bmanaged\b/i, phrase: "managed", evidenceKeywords: ["managed", "management"] },
      { pattern: /\bowned roadmap\b/i, phrase: "owned roadmap", evidenceKeywords: ["roadmap"] },
      { pattern: /\bled migration\b/i, phrase: "led migration", evidenceKeywords: ["migration"] },
      { pattern: /\bincreased revenue\b/i, phrase: "increased revenue", evidenceKeywords: ["revenue"] },
      { pattern: /\breduced cost\b/i, phrase: "reduced cost", evidenceKeywords: ["cost"] },
      { pattern: /\bimproved conversion\b/i, phrase: "improved conversion", evidenceKeywords: ["conversion"] },
    ];

    return checks
      .filter((check) => check.pattern.test(content))
      .filter((check) => !check.evidenceKeywords.some((keyword) => evidenceText.includes(keyword)))
      .map((check) => check.phrase);
  }

  private buildTruthfulnessRisk(
    sourceExperiences: Experience[],
    sourceEvidences: Evidence[],
    requirementMatches: EvidenceRequirementMatch[],
  ): RiskLevel {
    if (sourceExperiences.length === 0 || sourceEvidences.length === 0) {
      return "high";
    }
    if (requirementMatches.some((match) => match.matchedEvidences.length === 0)) {
      return "medium";
    }
    return "low";
  }

  private buildExaggerationRisk(
    artifact: GeneratedArtifact,
    exaggerationWarnings: string[],
  ): RiskLevel {
    if (exaggerationWarnings.some((warning) => warning.includes("unsupported number"))) {
      return "high";
    }
    if (exaggerationWarnings.length > 0 || artifact.scores.evidenceStrength < 0.5 || artifact.scores.overall < 0.5) {
      return "medium";
    }
    return "low";
  }

  private buildRiskLevel(
    truthfulnessRisk: RiskLevel,
    exaggerationRisk: RiskLevel,
  ): RiskLevel {
    if (truthfulnessRisk === "high" || exaggerationRisk === "high") {
      return "high";
    }
    if (truthfulnessRisk === "medium" || exaggerationRisk === "medium") {
      return "medium";
    }
    return "low";
  }

  private artifactTypeLabel(type: GeneratedArtifact["type"]): string {
    if (type === "resume_bullet") {
      return "resume bullet";
    }
    if (type === "resume_summary") {
      return "resume summary";
    }
    return "cover letter snippet";
  }

  private extractNumbers(text: string): string[] {
    return Array.from(new Set(text.match(/\d+(?:\.\d+)?%/g) ?? []));
  }
}
