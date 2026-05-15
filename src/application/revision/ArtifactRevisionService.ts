import type { GeneratedArtifactRepository } from "../../knowledge/repositories.js";
import { validateGeneratedArtifact } from "../../knowledge/schemas/index.js";
import type {
  ArtifactRevisionAgent,
  ArtifactRevisionInput,
  ArtifactRevisionResult,
} from "./types.js";

export type ArtifactRevisionServiceOptions = {
  revisionAgent: ArtifactRevisionAgent;
  artifactRepository?: GeneratedArtifactRepository;
};

export class ArtifactRevisionService {
  private readonly revisionAgent: ArtifactRevisionAgent;
  private readonly artifactRepository?: GeneratedArtifactRepository;

  public constructor(options: ArtifactRevisionServiceOptions) {
    this.revisionAgent = options.revisionAgent;
    this.artifactRepository = options.artifactRepository;
  }

  public async revise(input: ArtifactRevisionInput): Promise<ArtifactRevisionResult> {
    const result = await this.revisionAgent.revise(input);
    validateGeneratedArtifact(result.revisedArtifact);
    await this.artifactRepository?.save(result.revisedArtifact);
    return result;
  }
}
