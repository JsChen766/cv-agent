import { stableId, tokenize } from "../../knowledge/keywordUtils.js";
import type {
  Evidence,
  EvidenceChain,
  GeneratedArtifact,
  JDRequirement,
  Skill,
} from "../../knowledge/types.js";
import type { RetrievedExperience } from "../../knowledge/retrieval/ExperienceRetriever.js";
import type {
  ArtifactCoverageReport,
  EvaluateArtifactCoverageInput,
  RequirementCoverageItem,
  RequirementCoverageStatus,
} from "./types.js";

export class ArtifactCoverageEvaluator {
  evaluate(input: EvaluateArtifactCoverageInput): ArtifactCoverageReport {
    const createdAt = new Date().toISOString();
    const items = input.requirements.map((requirement) =>
      this.evaluateRequirement(requirement, input),
    );

    const coveredRequirementIds = this.idsByStatus(items, "covered");
    const weaklyCoveredRequirementIds = this.idsByStatus(items, "weakly_covered");
    const evidenceAvailableButNotUsedRequirementIds = this.idsByStatus(
      items,
      "evidence_available_but_not_used",
    );
    const noEvidenceRequirementIds = this.idsByStatus(items, "no_evidence");
    const notTargetedRequirementIds = this.idsByStatus(items, "not_targeted");

    return {
      id: stableId("coverage", `${input.userId}:${input.jdId}:${createdAt}`),
      jdId: input.jdId,
      userId: input.userId,
      totalRequirements: input.requirements.length,
      coveredRequirementIds,
      weaklyCoveredRequirementIds,
      evidenceAvailableButNotUsedRequirementIds,
      noEvidenceRequirementIds,
      notTargetedRequirementIds,
      items,
      summary: this.buildSummary({
        total: input.requirements.length,
        covered: coveredRequirementIds.length,
        weak: weaklyCoveredRequirementIds.length,
        unused: evidenceAvailableButNotUsedRequirementIds.length,
        noEvidence: noEvidenceRequirementIds.length,
        notTargeted: notTargetedRequirementIds.length,
      }),
      createdAt,
    };
  }

  private evaluateRequirement(
    requirement: JDRequirement,
    input: EvaluateArtifactCoverageInput,
  ): RequirementCoverageItem {
    const targetedArtifacts = input.artifacts.filter((artifact) =>
      artifact.targetRequirementIds.includes(requirement.id),
    );
    const chainMatches = targetedArtifacts.flatMap((artifact) =>
      this.findRequirementMatches(artifact, requirement, input.evidenceChains),
    );
    const supportingEvidenceIds = unique(
      chainMatches.flatMap((entry) =>
        entry.match.matchedEvidences.map((evidence) => evidence.id),
      ),
    );
    const supportingSkillIds = unique(
      chainMatches.flatMap((entry) =>
        entry.match.matchedSkills.map((skill) => skill.id),
      ),
    );

    if (targetedArtifacts.length > 0) {
      const hasCoveredMatch = chainMatches.some((entry) =>
        entry.match.matchedEvidences.length > 0 &&
        !this.riskBlocksRequirement(requirement, entry.chain) &&
        (
          entry.match.matchScore >= 0.5 ||
          this.evidenceTextSupportsRequirement(requirement, entry.match.matchedEvidences)
        ) &&
        this.chainSupportsRequirement(requirement, entry.chain),
      );
      const status: RequirementCoverageStatus = hasCoveredMatch
        ? "covered"
        : "weakly_covered";

      return {
        requirement,
        status,
        coveredByArtifactIds: targetedArtifacts.map((artifact) => artifact.id),
        supportingEvidenceIds,
        supportingSkillIds,
        reason: status === "covered"
          ? `Covered by ${targetedArtifacts.length} artifact${targetedArtifacts.length === 1 ? "" : "s"} with ${supportingEvidenceIds.length} supporting evidence item${supportingEvidenceIds.length === 1 ? "" : "s"}.`
          : "Targeted by generated artifact, but supporting evidence is weak or risk is medium.",
        suggestions: status === "covered"
          ? []
          : ["Review the linked artifact and add stronger evidence or revise the claim."],
      };
    }

    const available = this.findAvailableEvidence(requirement, input.retrievedExperiences);
    if (available.evidenceIds.length > 0) {
      return {
        requirement,
        status: "evidence_available_but_not_used",
        coveredByArtifactIds: [],
        supportingEvidenceIds: available.evidenceIds,
        supportingSkillIds: available.skillIds,
        reason: "Relevant evidence exists in the experience library, but no generated artifact currently targets this requirement.",
        suggestions: [
          "Generate an additional bullet targeting this requirement.",
          `Consider using evidence: ${available.evidenceIds[0]}`,
        ],
      };
    }

    return {
      requirement,
      status: "no_evidence",
      coveredByArtifactIds: [],
      supportingEvidenceIds: [],
      supportingSkillIds: [],
      reason: "No retrieved experience or evidence currently supports this requirement.",
      suggestions: [
        "Add a real experience or supporting evidence before claiming this requirement.",
      ],
    };
  }

  private findRequirementMatches(
    artifact: GeneratedArtifact,
    requirement: JDRequirement,
    evidenceChains: EvidenceChain[],
  ) {
    const chain = evidenceChains.find((entry) => entry.artifact.id === artifact.id);
    if (!chain) {
      return [];
    }
    return chain.requirementMatches
      .filter((match) => match.requirement.id === requirement.id)
      .map((match) => ({ chain, match }));
  }

  private chainSupportsRequirement(
    requirement: JDRequirement,
    chain: EvidenceChain,
  ): boolean {
    if (!this.isBroadRequirement(requirement)) {
      return true;
    }
    return this.contentAndEvidenceSupportBroadRequirement({
      requirement,
      content: chain.artifact.content,
      evidenceTexts: chain.sourceEvidences.map((evidence) => evidence.excerpt),
    });
  }

  private riskBlocksRequirement(
    requirement: JDRequirement,
    chain: EvidenceChain,
  ): boolean {
    if (chain.risk.level === "high") {
      return true;
    }
    if (chain.risk.exaggerationWarnings.length > 0) {
      return true;
    }
    return chain.risk.missingEvidenceClaims.some((claim) =>
      claim.includes(requirement.description),
    );
  }

  private evidenceTextSupportsRequirement(
    requirement: JDRequirement,
    evidences: Evidence[],
  ): boolean {
    const requirementTokens = tokenize(requirement.description);
    if (requirementTokens.length === 0) {
      return false;
    }
    const evidenceTokens = new Set(tokenize(evidences.map((evidence) => evidence.excerpt).join(" ")));
    return requirementTokens.some((token) => evidenceTokens.has(token));
  }

  private findAvailableEvidence(
    requirement: JDRequirement,
    retrievedExperiences: RetrievedExperience[],
  ): { evidenceIds: string[]; skillIds: string[] } {
    const evidenceById = new Map<string, Evidence>();
    const skillById = new Map<string, Skill>();

    for (const entry of retrievedExperiences) {
      for (const evidence of entry.matchedEvidences) {
        evidenceById.set(evidence.id, evidence);
      }
      for (const skill of entry.matchedSkills) {
        skillById.set(skill.id, skill);
      }
    }

    const matchedSkillIds = requirement.requiredSkillIds.filter((skillId) => {
      const skill = skillById.get(skillId);
      if (!skill) {
        return false;
      }
      return skill.evidenceIds.some((evidenceId) => evidenceById.has(evidenceId));
    });
    const skillEvidenceIds = matchedSkillIds.flatMap((skillId) =>
      skillById.get(skillId)?.evidenceIds.filter((evidenceId) => evidenceById.has(evidenceId)) ?? [],
    );

    if (this.isBroadRequirement(requirement)) {
      const broadEvidenceIds = Array.from(evidenceById.values())
        .filter((evidence) =>
          this.contentAndEvidenceSupportBroadRequirement({
            requirement,
            content: evidence.excerpt,
            evidenceTexts: [evidence.excerpt],
          }),
        )
        .map((evidence) => evidence.id);
      return {
        evidenceIds: unique([...skillEvidenceIds, ...broadEvidenceIds]),
        skillIds: matchedSkillIds,
      };
    }

    return {
      evidenceIds: unique(skillEvidenceIds),
      skillIds: matchedSkillIds,
    };
  }

  private isBroadRequirement(requirement: JDRequirement): boolean {
    return /\b(cross-team|collaboration|collaborate|product impact|measurable impact|business impact|adoption|stakeholder|organization-wide|company-wide)\b/i
      .test(requirement.description);
  }

  private contentAndEvidenceSupportBroadRequirement(input: {
    requirement: JDRequirement;
    content: string;
    evidenceTexts: string[];
  }): boolean {
    const description = input.requirement.description.toLowerCase();
    const evidenceText = input.evidenceTexts.join(" ");
    const checks: Array<() => boolean> = [];

    if (/\b(cross-team|collaboration|collaborate)\b/i.test(description)) {
      checks.push(() =>
        this.supportsCollaboration(input.content) && this.supportsCollaboration(evidenceText),
      );
    }
    if (/\b(product impact|measurable impact|business impact)\b/i.test(description)) {
      checks.push(() =>
        this.supportsImpact(input.content) && this.supportsImpact(evidenceText),
      );
    }
    if (/\badoption\b/i.test(description)) {
      checks.push(() =>
        this.supportsAdoption(input.content) && this.supportsAdoption(evidenceText),
      );
    }
    if (/\bstakeholder\b/i.test(description)) {
      checks.push(() =>
        this.supportsStakeholderWork(input.content) && this.supportsStakeholderWork(evidenceText),
      );
    }
    if (/\b(organization-wide|company-wide)\b/i.test(description)) {
      checks.push(() =>
        this.supportsOrganizationWideScope(input.content) &&
        this.supportsOrganizationWideScope(evidenceText),
      );
    }

    return checks.length > 0 && checks.every((check) => check());
  }

  private supportsCollaboration(text: string): boolean {
    return /\b(collaborat\w*|cross-team|cross-functional|worked with|partnered(?: with)?|worked across teams)\b/i
      .test(text);
  }

  private supportsImpact(text: string): boolean {
    return /%|\bby\s+\d+|\b(reduced|improved|increased|decreased|saved|delivered|lowered|raised|impact|measurable)\b/i
      .test(text);
  }

  private supportsAdoption(text: string): boolean {
    return /\b(adoption|adopted|rollout|rolled out|used by|usage)\b/i.test(text);
  }

  private supportsStakeholderWork(text: string): boolean {
    return /\b(stakeholder|alignment|aligned|requirements|gathered)\b/i.test(text);
  }

  private supportsOrganizationWideScope(text: string): boolean {
    return /\b(organization-wide|company-wide|companywide|company wide|org-wide|org wide|across the organization|across the company)\b/i
      .test(text);
  }

  private idsByStatus(
    items: RequirementCoverageItem[],
    status: RequirementCoverageStatus,
  ): string[] {
    return items
      .filter((item) => item.status === status)
      .map((item) => item.requirement.id);
  }

  private buildSummary(input: {
    total: number;
    covered: number;
    weak: number;
    unused: number;
    noEvidence: number;
    notTargeted: number;
  }): string {
    return `${input.covered}/${input.total} requirements covered, ${input.weak} weakly covered, ${input.unused} have evidence available but are not used, ${input.noEvidence} have no evidence, ${input.notTargeted} not targeted.`;
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
