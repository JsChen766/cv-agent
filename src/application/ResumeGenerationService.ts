import { EvidenceChainBuilder } from "../knowledge/EvidenceChainBuilder.js";
import { GraphViewBuilder } from "../knowledge/GraphViewBuilder.js";
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
import type { JDRequirementExtractor } from "./extractors/JDRequirementExtractor.js";
import type { ArtifactGenerator } from "./generators/ArtifactGenerator.js";

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
    private readonly requirementExtractor: JDRequirementExtractor,
    private readonly artifactGenerator: ArtifactGenerator,
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

    const { jdId, requirements } = await this.requirementExtractor.extract({
      userId: input.userId,
      jdText: input.jdText,
      targetRole: input.targetRole,
    });

    const retrievedExperiences = await this.retriever.retrieve({
      userId: input.userId,
      requirements,
      limit: 3,
    });

    const artifacts = await this.artifactGenerator.generate({
      userId: input.userId,
      jdId,
      jdText: input.jdText,
      targetRole: input.targetRole,
      requirements,
      retrievedExperiences,
    });

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

  private async loadRelevantSkills(
    userId: string,
    artifact: GeneratedArtifact,
  ): Promise<Skill[]> {
    const userSkills = await this.skillRepo.listByUserId(userId);
    return userSkills.filter((skill) => artifact.matchedSkillIds.includes(skill.id));
  }
}
