import { GenerationPersistenceService } from "../../application/generation/GenerationPersistenceService.js";
import type { GenerateResumeResult } from "../../application/ResumeGenerationService.js";
import type { GenerationPersistenceResult } from "../repositories.js";
import type { PostgresDatabase } from "./PostgresDatabase.js";
import { PostgresEvidenceChainSnapshotRepository } from "./PostgresEvidenceChainSnapshotRepository.js";
import {
  PostgresGenerationArtifactBundleRepository,
  PostgresGenerationSessionRepository,
} from "./PostgresGenerationSessionRepository.js";
import { PostgresGraphViewSnapshotRepository } from "./PostgresGraphViewSnapshotRepository.js";

export type PostgresGenerationPersistenceService = {
  persist(
    result: GenerateResumeResult,
    metadata?: Record<string, unknown>,
  ): Promise<GenerationPersistenceResult>;
};

export function createPostgresGenerationPersistenceService(
  database: Pick<PostgresDatabase, "transaction">,
): PostgresGenerationPersistenceService {
  return {
    persist: (result, metadata = {}) =>
      database.transaction((client) =>
        new GenerationPersistenceService(
          new PostgresGenerationSessionRepository(client),
          new PostgresEvidenceChainSnapshotRepository(client),
          new PostgresGraphViewSnapshotRepository(client),
          new PostgresGenerationArtifactBundleRepository(client),
        ).persist(result, metadata),
      ),
  };
}
