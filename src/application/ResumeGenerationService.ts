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
import { validateGeneratedArtifact } from "../knowledge/schemas.js";

export type GenerateResumeInput = {
  userId: string;
  jdText: string;
  targetRole: string;
};

export type GenerateResumeResult = {
  jdId: string;
  requirements: JDRequirement[];
  retrievedExperiences: RetrievedExperience[];
  artifacts: GeneratedArtifact[];
  evidenceChains: EvidenceChain[];
  graphViews: GraphView[];
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
    const artifacts = await this.mockArchitect(
      input,
      jdId,
      requirements,
      retrievedExperiences,
    );
    const evidenceChains: EvidenceChain[] = [];
    const graphViews: GraphView[] = [];

    for (const artifact of artifacts) {
      validateGeneratedArtifact(artifact);
      await this.artifactRepo.save(artifact);
      const relevantSkills = await this.loadRelevantSkills(input.userId, artifact);
      const evidenceChain = await this.chainBuilder.build(
        artifact,
        relevantSkills,
        requirements,
      );
      evidenceChains.push(evidenceChain);
      graphViews.push(this.graphBuilder.build(evidenceChain));
    }

    const [artifact] = artifacts;
    const [evidenceChain] = evidenceChains;
    const [graphView] = graphViews;

    return {
      jdId,
      requirements,
      retrievedExperiences,
      artifacts,
      evidenceChains,
      graphViews,
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
  ): Promise<GeneratedArtifact[]> {
    const now = new Date().toISOString();
    const topMatches = retrievedExperiences.slice(0, 3);
    if (topMatches.length === 0) {
      return [
        this.createArtifact({
          input,
          jdId,
          requirements,
          content: `Built relevant experience narrative for ${input.targetRole}; needs stronger evidence before use.`,
          sourceExperienceIds: [],
          sourceEvidenceIds: [],
          matchedSkillIds: [],
          score: 0,
          evidenceStrength: 0.2,
          now,
        }),
      ];
    }

    return topMatches.map((match) =>
      this.createArtifact({
        input,
        jdId,
        requirements,
        content: this.renderBullet(input.targetRole, match),
        sourceExperienceIds: [match.experience.id],
        sourceEvidenceIds: match.matchedEvidences.map((evidence) => evidence.id),
        matchedSkillIds: match.matchedSkills.map((skill) => skill.id),
        score: match.matchScore,
        evidenceStrength: match.matchedEvidences.length > 0 ? 0.85 : 0.2,
        now,
      }),
    );
  }

  private renderBullet(
    targetRole: string,
    retrievedExperience: RetrievedExperience,
  ): string {
    const support = retrievedExperience.reason.replace(/\.$/, "");
    return `Delivered ${targetRole} impact at ${retrievedExperience.experience.organization} as ${retrievedExperience.experience.role}, using ${support.toLowerCase()} to support ${retrievedExperience.experience.star.result}`;
  }

  private createArtifact(params: CreateArtifactInput): GeneratedArtifact {
    const score = Number(params.score.toFixed(3));
    return {
      id: stableId(
        "artifact",
        `${params.input.userId}:${params.jdId}:${params.content}`,
      ),
      userId: params.input.userId,
      type: "resume_bullet",
      content: params.content,
      sourceExperienceIds: params.sourceExperienceIds,
      sourceEvidenceIds: unique(params.sourceEvidenceIds),
      matchedSkillIds: unique(params.matchedSkillIds),
      targetJDId: params.jdId,
      targetRequirementIds: params.requirements.map((r) => r.id),
      targetRole: params.input.targetRole,
      scores: {
        overall: score,
        requirementMatch: score,
        evidenceStrength: params.evidenceStrength,
      },
      status: params.sourceEvidenceIds.length > 0 ? "ready" : "needs_review",
      createdAt: params.now,
      updatedAt: params.now,
    };
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

type CreateArtifactInput = {
  input: GenerateResumeInput;
  jdId: string;
  requirements: JDRequirement[];
  content: string;
  sourceExperienceIds: string[];
  sourceEvidenceIds: string[];
  matchedSkillIds: string[];
  score: number;
  evidenceStrength: number;
  now: string;
};
