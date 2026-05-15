import type {
  EvidenceChainSnapshot,
  EvidenceChainSnapshotRepository,
} from "../../persistence/repositories.js";
import type { EvidenceChainQueryResult } from "./types.js";

export class EvidenceChainQueryService {
  public constructor(
    private readonly repository: EvidenceChainSnapshotRepository,
  ) {}

  public async getBySnapshotId(
    userId: string,
    snapshotId: string,
  ): Promise<EvidenceChainQueryResult> {
    const snapshot = await this.repository.getById(userId, snapshotId);
    return this.toResult(snapshot ? [snapshot] : []);
  }

  public async listBySessionId(
    userId: string,
    sessionId: string,
  ): Promise<EvidenceChainQueryResult> {
    return this.toResult(await this.repository.listBySessionId(userId, sessionId));
  }

  public async listByArtifactId(
    userId: string,
    artifactId: string,
  ): Promise<EvidenceChainQueryResult> {
    return this.toResult(await this.repository.listByArtifactId(userId, artifactId));
  }

  private toResult(evidenceChains: EvidenceChainSnapshot[]): EvidenceChainQueryResult {
    return {
      evidenceChains,
      summary: `Found ${evidenceChains.length} evidence chains. They explain how generated artifacts are supported by source experiences, evidences, and skills.`,
    };
  }
}
