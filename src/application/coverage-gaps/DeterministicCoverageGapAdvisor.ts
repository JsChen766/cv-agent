import { stableId } from "../../knowledge/keywordUtils.js";
import type {
  Evidence,
  JDRequirement,
  RiskLevel,
} from "../../knowledge/types.js";
import type { RetrievedExperience } from "../../knowledge/retrieval/ExperienceRetriever.js";
import type { RequirementCoverageItem } from "../evaluation/types.js";
import type { CoverageGapAdvisor } from "./CoverageGapAdvisor.js";
import type {
  AdviseCoverageGapsInput,
  CoverageGapItem,
  CoverageGapReport,
  EvidenceRequestSuggestion,
  SupplementalArtifactSuggestion,
} from "./types.js";

export class DeterministicCoverageGapAdvisor implements CoverageGapAdvisor {
  async advise(input: AdviseCoverageGapsInput): Promise<CoverageGapReport> {
    const createdAt = new Date().toISOString();
    const items = input.coverageReport.items
      .map((item) => this.buildGapItem(item, input))
      .filter((item): item is CoverageGapItem => item !== null);
    const supplementalArtifactCount = items.reduce(
      (count, item) => count + item.supplementalArtifactSuggestions.length,
      0,
    );
    const evidenceRequestCount = items.reduce(
      (count, item) => count + item.evidenceRequestSuggestions.length,
      0,
    );

    return {
      id: stableId("coverage-gap", `${input.userId}:${input.jdId}:${createdAt}`),
      userId: input.userId,
      jdId: input.jdId,
      items,
      supplementalArtifactCount,
      evidenceRequestCount,
      summary: `${items.length} coverage gap${items.length === 1 ? "" : "s"} identified. ${supplementalArtifactCount} supplemental artifact suggestion${supplementalArtifactCount === 1 ? "" : "s"} and ${evidenceRequestCount} evidence request suggestion${evidenceRequestCount === 1 ? "" : "s"} generated.`,
      createdAt,
    };
  }

  private buildGapItem(
    item: RequirementCoverageItem,
    input: AdviseCoverageGapsInput,
  ): CoverageGapItem | null {
    if (item.status === "covered") {
      return null;
    }

    if (item.status === "evidence_available_but_not_used") {
      const suggestion = this.buildSupplementalArtifactSuggestion({
        requirement: item.requirement,
        supportingEvidenceIds: item.supportingEvidenceIds,
        supportingSkillIds: item.supportingSkillIds,
        retrievedExperiences: input.retrievedExperiences,
        confidence: 0.75,
        riskLevel: "low",
        rationale:
          "This requirement has supporting evidence but no generated artifact currently targets it.",
      });

      return {
        requirement: item.requirement,
        gapType: "missing_artifact",
        severity: "medium",
        existingEvidenceIds: item.supportingEvidenceIds,
        existingArtifactIds: item.coveredByArtifactIds,
        supplementalArtifactSuggestions: suggestion ? [suggestion] : [],
        evidenceRequestSuggestions: [],
        reason:
          "Relevant evidence exists, but no generated artifact currently targets this requirement.",
      };
    }

    if (item.status === "weakly_covered") {
      const suggestion = this.buildSupplementalArtifactSuggestion({
        requirement: item.requirement,
        supportingEvidenceIds: item.supportingEvidenceIds,
        supportingSkillIds: item.supportingSkillIds,
        retrievedExperiences: input.retrievedExperiences,
        confidence: 0.5,
        riskLevel: "medium",
        rationale:
          "This requirement is targeted, but the current coverage is weak or carries medium risk.",
      });

      return {
        requirement: item.requirement,
        gapType: "weak_coverage",
        severity: "medium",
        existingEvidenceIds: item.supportingEvidenceIds,
        existingArtifactIds: item.coveredByArtifactIds,
        supplementalArtifactSuggestions: suggestion ? [suggestion] : [],
        evidenceRequestSuggestions: this.buildEvidenceRequestSuggestions(
          item.requirement,
          "Current generated content targets this requirement, but stronger evidence would reduce risk.",
        ),
        reason:
          "Generated content targets this requirement, but supporting evidence or risk calibration is weak.",
      };
    }

    if (item.status === "not_targeted" && item.supportingEvidenceIds.length > 0) {
      const suggestion = this.buildSupplementalArtifactSuggestion({
        requirement: item.requirement,
        supportingEvidenceIds: item.supportingEvidenceIds,
        supportingSkillIds: item.supportingSkillIds,
        retrievedExperiences: input.retrievedExperiences,
        confidence: 0.75,
        riskLevel: "low",
        rationale:
          "This requirement has supporting evidence but no generated artifact currently targets it.",
      });

      return {
        requirement: item.requirement,
        gapType: "missing_artifact",
        severity: "medium",
        existingEvidenceIds: item.supportingEvidenceIds,
        existingArtifactIds: item.coveredByArtifactIds,
        supplementalArtifactSuggestions: suggestion ? [suggestion] : [],
        evidenceRequestSuggestions: [],
        reason:
          "The requirement is not targeted, but retrieved evidence could support a supplemental artifact.",
      };
    }

    return {
      requirement: item.requirement,
      gapType: "missing_evidence",
      severity: "high",
      existingEvidenceIds: item.supportingEvidenceIds,
      existingArtifactIds: item.coveredByArtifactIds,
      supplementalArtifactSuggestions: [],
      evidenceRequestSuggestions: this.buildEvidenceRequestSuggestions(
        item.requirement,
        "No retrieved evidence currently supports this requirement.",
      ),
      reason:
        "No retrieved evidence currently supports this requirement, so generating a resume claim would be risky.",
    };
  }

  private buildSupplementalArtifactSuggestion(input: {
    requirement: JDRequirement;
    supportingEvidenceIds: string[];
    supportingSkillIds: string[];
    retrievedExperiences: RetrievedExperience[];
    confidence: number;
    riskLevel: RiskLevel;
    rationale: string;
  }): SupplementalArtifactSuggestion | null {
    const evidenceById = this.collectEvidenceById(input.retrievedExperiences);
    const supportingEvidences = unique(input.supportingEvidenceIds)
      .map((id) => evidenceById.get(id))
      .filter(Boolean) as Evidence[];

    if (supportingEvidences.length === 0) {
      return null;
    }

    const content = this.buildSupplementalContent(
      input.requirement,
      supportingEvidences,
    );

    return {
      type: "resume_bullet",
      content,
      sourceExperienceIds: unique(
        supportingEvidences.map((evidence) => evidence.experienceId),
      ),
      sourceEvidenceIds: supportingEvidences.map((evidence) => evidence.id),
      matchedSkillIds: unique([
        ...input.supportingSkillIds,
        ...input.requirement.requiredSkillIds,
      ]),
      targetRequirementIds: [input.requirement.id],
      confidence: input.confidence,
      riskLevel: input.riskLevel,
      rationale: input.rationale,
    };
  }

  private buildSupplementalContent(
    requirement: JDRequirement,
    evidences: Evidence[],
  ): string {
    const description = requirement.description.toLowerCase();
    const excerpt = evidences[0]?.excerpt ?? "";
    const shortExcerpt = this.shortExcerpt(excerpt);
    const text = evidences.map((evidence) => evidence.excerpt).join(" ");

    if (/\b(api|integration|data flow)\b/i.test(description)) {
      return `Applied API integration experience supported by evidence: ${shortExcerpt}.`;
    }

    if (/\b(accessibility|accessible|wcag)\b/i.test(description)) {
      if (/\bwcag\b/i.test(text)) {
        return "Built accessible frontend components using WCAG practices, supported by component library implementation evidence.";
      }
      return `Applied accessibility practices supported by evidence: ${shortExcerpt}.`;
    }

    if (/\b(performance|optimization|bundle)\b/i.test(description)) {
      const percent = text.match(/\b\d+(?:\.\d+)?%/)?.[0];
      if (percent && /bundle size/i.test(text)) {
        return `Improved frontend performance by reducing bundle size by ${percent} through optimization work.`;
      }
      return `Improved frontend performance supported by evidence: ${shortExcerpt}.`;
    }

    if (/\b(react|typescript|design system|component library)\b/i.test(description)) {
      const technologies = [
        /\breact\b/i.test(text) ? "React" : null,
        /\btypescript\b/i.test(text) ? "TypeScript" : null,
      ].filter(Boolean);
      const scope = text.match(/\b(?:for|across)\s+\d+\s+\w*\s*teams\b/i)?.[0];
      if (technologies.length > 0 && /design system/i.test(text)) {
        return `Applied ${technologies.join(" and ")} in a design system project${scope ? ` ${scope}` : ""}.`;
      }
      return `Applied frontend implementation experience supported by evidence: ${shortExcerpt}.`;
    }

    return `Applied ${this.requirementKeyword(requirement)} experience through: ${shortExcerpt}.`;
  }

  private buildEvidenceRequestSuggestions(
    requirement: JDRequirement,
    reason: string,
  ): EvidenceRequestSuggestion[] {
    const description = requirement.description.toLowerCase();

    if (/\b(collaboration|cross-team|cross-functional|collaborate)\b/.test(description)) {
      return [{
        prompt: "请补充一个你和多个团队协作解决问题的真实经历，包括你的角色、合作对象、行动和结果。",
        expectedEvidenceType: "collaboration",
        reason,
      }];
    }

    if (/\b(product impact|business impact|measurable impact|impact)\b/.test(description)) {
      return [{
        prompt: "请补充一个能证明业务或产品影响的真实结果，例如指标提升、成本降低、效率提升或用户影响。",
        expectedEvidenceType: "business_impact",
        reason,
      }];
    }

    if (/\b(leadership|led|ownership|owned|lead)\b/.test(description)) {
      return [{
        prompt: "请补充一个你主导项目或承担关键责任的真实经历，包括决策、执行和结果。",
        expectedEvidenceType: "leadership",
        reason,
      }];
    }

    if (/\b(performance|optimization|optimize)\b/.test(description)) {
      return [{
        prompt: "请补充一个性能优化经历，最好包含优化前后指标。",
        expectedEvidenceType: "metric",
        reason,
      }];
    }

    if (/\b(api|integration|data flow)\b/.test(description)) {
      return [{
        prompt: "请补充一个 API 集成或前端数据流管理的真实经历，包括你处理的系统、接口复杂度和结果。",
        expectedEvidenceType: "technical_detail",
        reason,
      }];
    }

    return [{
      prompt: "请补充一个能证明该岗位要求的真实经历，包括背景、行动和结果。",
      expectedEvidenceType: "other",
      reason,
    }];
  }

  private collectEvidenceById(
    retrievedExperiences: RetrievedExperience[],
  ): Map<string, Evidence> {
    const evidenceById = new Map<string, Evidence>();
    for (const retrieved of retrievedExperiences) {
      for (const evidence of [...retrieved.evidences, ...retrieved.matchedEvidences]) {
        evidenceById.set(evidence.id, evidence);
      }
    }
    return evidenceById;
  }

  private shortExcerpt(excerpt: string): string {
    const normalized = excerpt.trim().replace(/\s+/g, " ").replace(/[.。;；]+$/, "");
    return normalized.length > 140
      ? `${normalized.slice(0, 137).trim()}...`
      : normalized;
  }

  private requirementKeyword(requirement: JDRequirement): string {
    const token = requirement.description
      .toLowerCase()
      .replace(/[^a-z0-9+#\s]+/g, " ")
      .split(/\s+/)
      .find((value) => value.length > 3);
    return token ?? "relevant";
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
