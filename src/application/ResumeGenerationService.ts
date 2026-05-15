import { EvidenceChainBuilder } from "../knowledge/EvidenceChainBuilder.js";
import { GraphViewBuilder } from "../knowledge/GraphViewBuilder.js";
import type {
  Evidence,
  EvidenceChain,
  Experience,
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
import { ArtifactCoverageEvaluator } from "./evaluation/ArtifactCoverageEvaluator.js";
import type { ArtifactCoverageReport } from "./evaluation/types.js";
import { DeterministicArtifactCritic } from "./critique/DeterministicArtifactCritic.js";
import type {
  ArtifactCritic,
  ArtifactCritiqueReport,
} from "./critique/types.js";
import { DeterministicCoverageGapAdvisor } from "./coverage-gaps/DeterministicCoverageGapAdvisor.js";
import type {
  CoverageGapAdvisor,
  CoverageGapReport,
} from "./coverage-gaps/index.js";

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
  coverageReport: ArtifactCoverageReport;
  coverageGapReport: CoverageGapReport;
  critiqueReport: ArtifactCritiqueReport;
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
    private readonly coverageEvaluator = new ArtifactCoverageEvaluator(),
    private readonly coverageGapAdvisor: CoverageGapAdvisor = new DeterministicCoverageGapAdvisor(),
    private readonly artifactCritic: ArtifactCritic = new DeterministicArtifactCritic(),
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

    const generatorContext = this.toGeneratorContext(retrievedExperiences);
    const artifactGeneration = await this.artifactGenerator.generate({
      userId: input.userId,
      jdId,
      jdText: input.jdText,
      targetRole: input.targetRole,
      requirements,
      experiences: generatorContext.experiences,
      evidences: generatorContext.evidences,
      skills: generatorContext.skills,
      retrievedExperiences,
    });
    const artifacts = artifactGeneration.artifacts;

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
    const coverageReport = this.coverageEvaluator.evaluate({
      userId: input.userId,
      jdId,
      requirements,
      retrievedExperiences,
      artifacts,
      evidenceChains,
    });
    const coverageGapReport = await this.coverageGapAdvisor.advise({
      userId: input.userId,
      jdId,
      coverageReport,
      retrievedExperiences,
      artifacts,
    });
    const critiqueReport = await this.artifactCritic.critique({
      userId: input.userId,
      jdId,
      artifacts,
      evidenceChains,
      coverageReport,
    });

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
      coverageReport,
      coverageGapReport,
      critiqueReport,
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

  private toGeneratorContext(retrievedExperiences: RetrievedExperience[]): {
    experiences: Experience[];
    evidences: Evidence[];
    skills: Skill[];
  } {
    const experiences = new Map<string, Experience>();
    const evidences = new Map<string, Evidence>();
    const skills = new Map<string, Skill>();
    for (const retrieved of retrievedExperiences) {
      experiences.set(retrieved.experience.id, retrieved.experience);
      for (const evidence of retrieved.evidences) {
        evidences.set(evidence.id, evidence);
      }
      for (const evidence of retrieved.matchedEvidences) {
        evidences.set(evidence.id, evidence);
      }
      for (const skill of retrieved.skills) {
        skills.set(skill.id, skill);
      }
      for (const skill of retrieved.matchedSkills) {
        skills.set(skill.id, skill);
      }
    }
    return {
      experiences: Array.from(experiences.values()),
      evidences: Array.from(evidences.values()),
      skills: Array.from(skills.values()),
    };
  }
}
