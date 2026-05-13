import { EvidenceChainBuilder } from "../knowledge/EvidenceChainBuilder.js";
import { GraphViewBuilder } from "../knowledge/GraphViewBuilder.js";
import {
  detectKnownSkills,
  skillIdFor,
  stableId,
} from "../knowledge/keywordUtils.js";
import type {
  EvidenceChain,
  GeneratedArtifact,
  GraphView,
  JDRequirement,
  Skill,
} from "../knowledge/types.js";
import type {
  EvidenceRepository,
  ExperienceRepository,
  GeneratedArtifactRepository,
  JDRequirementRepository,
  SkillRepository,
} from "../knowledge/repositories.js";
import type {
  ExperienceRetriever,
  RetrievedExperience,
} from "../knowledge/retrieval/ExperienceRetriever.js";

export type GenerateResumeInput = {
  userId: string;
  jdText: string;
  targetRole: string;
};

export type GenerateResumeResult = {
  jdId: string;
  requirements: JDRequirement[];
  retrievedExperiences: RetrievedExperience[];
  artifact: GeneratedArtifact;
  evidenceChain: EvidenceChain;
  graphView: GraphView;
};

export class ResumeGenerationService {
  constructor(
    private readonly experienceRepo: ExperienceRepository,
    private readonly evidenceRepo: EvidenceRepository,
    private readonly skillRepo: SkillRepository,
    private readonly requirementRepo: JDRequirementRepository,
    private readonly artifactRepo: GeneratedArtifactRepository,
    private readonly retriever: ExperienceRetriever,
    private readonly chainBuilder = new EvidenceChainBuilder(
      experienceRepo,
      evidenceRepo,
    ),
    private readonly graphBuilder = new GraphViewBuilder(),
  ) {}

  async generate(input: GenerateResumeInput): Promise<GenerateResumeResult> {
    const { jdId, requirements } = await this.mockStrategist(input);
    const retrievedExperiences = await this.retriever.retrieve({
      userId: input.userId,
      requirements,
      limit: 3,
    });
    const artifact = await this.mockArchitect(input, jdId, requirements, retrievedExperiences);
    await this.artifactRepo.save(artifact);

    const relevantSkills = await this.loadRelevantSkills(input.userId, artifact);
    const evidenceChain = await this.chainBuilder.build(
      artifact,
      relevantSkills,
      requirements,
    );
    const graphView = this.graphBuilder.build(evidenceChain);

    return {
      jdId,
      requirements,
      retrievedExperiences,
      artifact,
      evidenceChain,
      graphView,
    };
  }

  private async mockStrategist(
    input: GenerateResumeInput,
  ): Promise<{ jdId: string; requirements: JDRequirement[] }> {
    const now = new Date().toISOString();
    const jdId = stableId("jd", `${input.userId}:${input.targetRole}:${input.jdText}`);
    const detectedSkills = detectKnownSkills(input.jdText);
    const requiredSkillIds: string[] = [];

    for (const detected of detectedSkills) {
      const existing = await this.skillRepo.findByName(input.userId, detected.name);
      if (existing) {
        requiredSkillIds.push(existing.id);
        continue;
      }

      const skill: Skill = {
        id: skillIdFor(input.userId, detected.name),
        userId: input.userId,
        name: detected.name,
        category: detected.category,
        evidenceIds: [],
        createdAt: now,
        updatedAt: now,
      };
      await this.skillRepo.save(skill);
      requiredSkillIds.push(skill.id);
    }

    const requirement: JDRequirement = {
      id: stableId("req", `${jdId}:core`),
      userId: input.userId,
      jdId,
      description: input.jdText,
      requiredSkillIds,
      weight: 1,
      createdAt: now,
    };
    await this.requirementRepo.save(requirement);

    return { jdId, requirements: [requirement] };
  }

  private async mockArchitect(
    input: GenerateResumeInput,
    jdId: string,
    requirements: JDRequirement[],
    retrievedExperiences: RetrievedExperience[],
  ): Promise<GeneratedArtifact> {
    const now = new Date().toISOString();
    const topMatches = retrievedExperiences.slice(0, 2);
    const sourceExperienceIds = topMatches.map((r) => r.experience.id);
    const sourceEvidenceIds = unique(topMatches.flatMap((r) => r.matchedEvidenceIds));
    const matchedSkillIds = unique(topMatches.flatMap((r) => r.matchedSkillIds));
    const averageScore =
      topMatches.length === 0
        ? 0
        : topMatches.reduce((sum, item) => sum + item.matchScore, 0) / topMatches.length;

    const content =
      topMatches.length === 0
        ? `Built relevant experience narrative for ${input.targetRole}; needs stronger evidence before use.`
        : this.renderBullet(input.targetRole, topMatches);

    return {
      id: stableId("artifact", `${input.userId}:${jdId}:${content}`),
      userId: input.userId,
      type: "resume_bullet",
      content,
      sourceExperienceIds,
      sourceEvidenceIds,
      matchedSkillIds,
      targetJDId: jdId,
      targetRequirementIds: requirements.map((r) => r.id),
      targetRole: input.targetRole,
      scores: {
        overall: Number(averageScore.toFixed(3)),
        requirementMatch: Number(averageScore.toFixed(3)),
        evidenceStrength: sourceEvidenceIds.length > 0 ? 0.85 : 0.2,
      },
      status: sourceEvidenceIds.length > 0 ? "ready" : "needs_review",
      createdAt: now,
      updatedAt: now,
    };
  }

  private renderBullet(
    targetRole: string,
    retrievedExperiences: RetrievedExperience[],
  ): string {
    const top = retrievedExperiences[0];
    const support = top.reason.replace(/\.$/, "");
    return `Delivered ${targetRole} impact at ${top.experience.organization} as ${top.experience.role}, using ${support.toLowerCase()} to support ${top.experience.star.result}`;
  }

  private async loadRelevantSkills(
    userId: string,
    artifact: GeneratedArtifact,
  ): Promise<Skill[]> {
    const userSkills = await this.skillRepo.listByUserId(userId);
    return userSkills.filter((skill) => artifact.matchedSkillIds.includes(skill.id));
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
