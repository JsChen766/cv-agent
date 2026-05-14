import type { BaseAgent } from "../../core/agent/BaseAgent.js";
import type {
  EvidenceRepository,
  ExperienceRepository,
  GeneratedArtifactRepository,
  JDRequirementRepository,
  SkillRepository,
} from "../../knowledge/repositories.js";
import type { ExperienceRetriever } from "../../knowledge/retrieval/ExperienceRetriever.js";
import { ResumeGenerationService } from "../ResumeGenerationService.js";
import { AgentArtifactCritic } from "../critique/AgentArtifactCritic.js";
import { AgentJDRequirementExtractor } from "../extractors/AgentJDRequirementExtractor.js";
import { AgentArtifactGenerator } from "../generators/AgentArtifactGenerator.js";

export type AgentBackedResumeGenerationConfig = {
  strategistAgent: BaseAgent;
  architectAgent: BaseAgent;
  experienceRepo: ExperienceRepository;
  evidenceRepo: EvidenceRepository;
  skillRepo: SkillRepository;
  requirementRepo: JDRequirementRepository;
  artifactRepo: GeneratedArtifactRepository;
  retriever: ExperienceRetriever;
  criticAgent?: BaseAgent;
  useAgentCritic?: boolean;
};

export function createAgentBackedResumeGenerationService(
  config: AgentBackedResumeGenerationConfig,
): ResumeGenerationService {
  const requirementExtractor = new AgentJDRequirementExtractor(
    config.strategistAgent,
    config.skillRepo,
    config.requirementRepo,
  );

  const artifactGenerator = new AgentArtifactGenerator(config.architectAgent);
  const artifactCritic =
    config.useAgentCritic && config.criticAgent
      ? new AgentArtifactCritic(config.criticAgent)
      : undefined;

  return new ResumeGenerationService(
    requirementExtractor,
    artifactGenerator,
    config.experienceRepo,
    config.evidenceRepo,
    config.skillRepo,
    config.requirementRepo,
    config.artifactRepo,
    config.retriever,
    undefined,
    undefined,
    undefined,
    artifactCritic,
  );
}
