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
import {
  validateGeneratedArtifact,
  validateGraphView,
} from "../knowledge/schemas/index.js";

export type GenerateResumeInput = {
  userId: string;
  jdText: string;
  targetRole: string;
};

export type GenerateResumeResult = {
  userId: string;
  jdId: string;
  jdText: string;
  targetRole: string;
  requirements: JDRequirement[];
  retrievedExperiences: RetrievedExperience[];
  artifacts: GeneratedArtifact[];
  evidenceChains: EvidenceChain[];
  graphViews: GraphView[];
  createdAt: string;
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
    const createdAt = new Date().toISOString();
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
      const graphView = this.graphBuilder.build(evidenceChain);
      validateGraphView(graphView);
      graphViews.push(graphView);
    }

    return {
      userId: input.userId,
      jdId,
      jdText: input.jdText,
      targetRole: input.targetRole,
      requirements,
      retrievedExperiences,
      artifacts,
      evidenceChains,
      graphViews,
      createdAt,
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
    const styles: ArtifactStyle[] = [
      "technical",
      "product_impact",
      "architecture",
    ];

    return styles.map((style, index) => {
      const match =
        retrievedExperiences.length > 0
          ? retrievedExperiences[index % retrievedExperiences.length]
          : null;

      return match
        ? this.createArtifact({
            input,
            jdId,
            requirements,
            style,
            content: this.renderBullet(input.targetRole, match, style),
            sourceExperienceIds: [match.experience.id],
            sourceEvidenceIds: match.matchedEvidences.map((evidence) => evidence.id),
            matchedSkillIds: match.matchedSkills.map((skill) => skill.id),
            score: match.matchScore,
            evidenceStrength: match.matchedEvidences.length > 0 ? 0.85 : 0.2,
            now,
          })
        : this.createArtifact({
            input,
            jdId,
            requirements,
            style,
            content: this.renderNoEvidenceBullet(input.targetRole, style),
            sourceExperienceIds: [],
            sourceEvidenceIds: [],
            matchedSkillIds: [],
            score: 0,
            evidenceStrength: 0.2,
            now,
          });
    });
  }

  private renderBullet(
    targetRole: string,
    retrievedExperience: RetrievedExperience,
    style: ArtifactStyle,
  ): string {
    const support = retrievedExperience.reason.replace(/\.$/, "").toLowerCase();
    const result = retrievedExperience.experience.star.result;
    const baseContext = `${retrievedExperience.experience.organization} as ${retrievedExperience.experience.role}`;

    if (style === "technical") {
      return `Built ${targetRole} capabilities at ${baseContext}, applying ${support} to deliver ${result}`;
    }
    if (style === "product_impact") {
      return `Improved product outcomes for ${targetRole} work at ${baseContext}, using ${support} to support ${result}`;
    }
    return `Strengthened frontend architecture at ${baseContext} for ${targetRole} scope, connecting ${support} with ${result}`;
  }

  private renderNoEvidenceBullet(
    targetRole: string,
    style: ArtifactStyle,
  ): string {
    if (style === "technical") {
      return `Draft technical ${targetRole} bullet requires source experience and evidence before use.`;
    }
    if (style === "product_impact") {
      return `Draft product impact ${targetRole} bullet requires quantified supporting evidence before use.`;
    }
    return `Draft architecture ${targetRole} bullet requires architecture evidence before use.`;
  }

  private createArtifact(params: CreateArtifactInput): GeneratedArtifact {
    const score = Number(params.score.toFixed(3));
    return {
      id: stableId(
        "artifact",
        `${params.input.userId}:${params.jdId}:${params.style}:${params.content}`,
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

type ArtifactStyle = "technical" | "product_impact" | "architecture";

type CreateArtifactInput = {
  input: GenerateResumeInput;
  jdId: string;
  requirements: JDRequirement[];
  style: ArtifactStyle;
  content: string;
  sourceExperienceIds: string[];
  sourceEvidenceIds: string[];
  matchedSkillIds: string[];
  score: number;
  evidenceStrength: number;
  now: string;
};
