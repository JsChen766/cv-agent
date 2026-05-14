import type { BaseAgent } from "../../core/agent/BaseAgent.js";
import type {
  EvidenceRepository,
  ExperienceRepository,
  SkillRepository,
} from "../../knowledge/repositories.js";
import { ExperienceIngestionService } from "../../knowledge/ingestion/ExperienceIngestionService.js";
import { AgentExperienceExtractor } from "../../knowledge/ingestion/extractors/AgentExperienceExtractor.js";

export type AgentBackedExperienceIngestionConfig = {
  archivistAgent: BaseAgent;
  experienceRepo: ExperienceRepository;
  evidenceRepo: EvidenceRepository;
  skillRepo: SkillRepository;
};

export function createAgentBackedExperienceIngestionService(
  config: AgentBackedExperienceIngestionConfig,
): ExperienceIngestionService {
  return new ExperienceIngestionService(
    config.experienceRepo,
    config.evidenceRepo,
    config.skillRepo,
    new AgentExperienceExtractor(config.archivistAgent),
  );
}
