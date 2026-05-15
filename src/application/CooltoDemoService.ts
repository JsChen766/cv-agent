import type {
  GenerateResumeResponse,
  IngestExperienceResponse,
} from "../api-contracts/index.js";
import {
  ExperienceIngestionService,
  InMemoryEvidenceRepository,
  InMemoryExperienceRepository,
  InMemoryGeneratedArtifactRepository,
  InMemoryJDRequirementRepository,
  InMemorySkillRepository,
  KeywordExperienceRetriever,
} from "../knowledge/index.js";
import type { ExperienceIngestionService as ExperienceIngestionServiceType } from "../knowledge/ingestion/ExperienceIngestionService.js";
import { ResumeGenerationService } from "./ResumeGenerationService.js";
import type { ResumeGenerationService as ResumeGenerationServiceType } from "./ResumeGenerationService.js";
import { DeterministicJDRequirementExtractor } from "./extractors/DeterministicJDRequirementExtractor.js";
import { DeterministicArtifactGenerator } from "./generators/DeterministicArtifactGenerator.js";
import {
  toGenerateResumeResponse,
  toIngestExperienceResponse,
} from "./mappers/index.js";

export type RunCooltoDemoInput = {
  userId: string;
  rawExperienceText: string;
  jdText: string;
  targetRole: string;
};

export type RunCooltoDemoResult = {
  ingest: IngestExperienceResponse;
  generation: GenerateResumeResponse;
};

export class CooltoDemoService {
  constructor(
    private readonly ingestionService: ExperienceIngestionServiceType,
    private readonly resumeGenerationService: ResumeGenerationServiceType,
  ) {}

  async run(input: RunCooltoDemoInput): Promise<RunCooltoDemoResult> {
    const ingestResult = await this.ingestionService.ingest({
      userId: input.userId,
      rawText: input.rawExperienceText,
      sourceRef: "coolto-demo:raw-experience",
    });
    const generationResult = await this.resumeGenerationService.generate({
      userId: input.userId,
      jdText: input.jdText,
      targetRole: input.targetRole,
    });

    return {
      ingest: toIngestExperienceResponse(ingestResult),
      generation: toGenerateResumeResponse(generationResult),
    };
  }
}

export function createInMemoryCooltoDemoService(): CooltoDemoService {
  const experienceRepo = new InMemoryExperienceRepository();
  const evidenceRepo = new InMemoryEvidenceRepository();
  const skillRepo = new InMemorySkillRepository();
  const requirementRepo = new InMemoryJDRequirementRepository();
  const artifactRepo = new InMemoryGeneratedArtifactRepository();

  const ingestionService = new ExperienceIngestionService(
    experienceRepo,
    evidenceRepo,
    skillRepo,
  );

  const retriever = new KeywordExperienceRetriever(
    experienceRepo,
    evidenceRepo,
    skillRepo,
  );

  const requirementExtractor = new DeterministicJDRequirementExtractor(
    skillRepo,
    requirementRepo,
  );

  const artifactGenerator = new DeterministicArtifactGenerator();

  const resumeGenerationService = new ResumeGenerationService({
    requirementExtractor,
    artifactGenerator,
    experienceRepo,
    evidenceRepo,
    skillRepo,
    requirementRepo,
    artifactRepo,
    retriever,
  });

  return new CooltoDemoService(ingestionService, resumeGenerationService);
}
