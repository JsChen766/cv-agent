import type { BaseAgent } from "../../core/agent/BaseAgent.js";
import {
  InMemoryEvidenceRepository,
  InMemoryExperienceRepository,
  InMemoryGeneratedArtifactRepository,
  InMemoryJDRequirementRepository,
  InMemorySkillRepository,
  KeywordExperienceRetriever,
} from "../../knowledge/index.js";
import { CooltoDemoService } from "../CooltoDemoService.js";
import { createAgentBackedExperienceIngestionService } from "./createAgentBackedExperienceIngestionService.js";
import { createAgentBackedResumeGenerationService } from "./createAgentBackedResumeGenerationService.js";

export type AgentBackedCooltoDemoConfig = {
  archivistAgent: BaseAgent;
  strategistAgent: BaseAgent;
  architectAgent: BaseAgent;
  criticAgent?: BaseAgent;
  useAgentCritic?: boolean;
};

export function createAgentBackedCooltoDemoService(
  config: AgentBackedCooltoDemoConfig,
): CooltoDemoService {
  const experienceRepo = new InMemoryExperienceRepository();
  const evidenceRepo = new InMemoryEvidenceRepository();
  const skillRepo = new InMemorySkillRepository();
  const requirementRepo = new InMemoryJDRequirementRepository();
  const artifactRepo = new InMemoryGeneratedArtifactRepository();

  const ingestionService = createAgentBackedExperienceIngestionService({
    archivistAgent: config.archivistAgent,
    experienceRepo,
    evidenceRepo,
    skillRepo,
  });

  const retriever = new KeywordExperienceRetriever(
    experienceRepo,
    evidenceRepo,
    skillRepo,
  );

  const resumeGenerationService = createAgentBackedResumeGenerationService({
    strategistAgent: config.strategistAgent,
    architectAgent: config.architectAgent,
    experienceRepo,
    evidenceRepo,
    skillRepo,
    requirementRepo,
    artifactRepo,
    retriever,
    criticAgent: config.criticAgent,
    useAgentCritic: config.useAgentCritic,
  });

  return new CooltoDemoService(ingestionService, resumeGenerationService);
}
