import { describe, expect, it } from "vitest";
import {
  ArtifactRevisionService,
  type ArtifactRevisionAgent,
  type ArtifactRevisionInput,
  type ArtifactRevisionResult,
} from "../src/application/revision/index.js";
import type { GeneratedArtifactRepository } from "../src/knowledge/repositories.js";
import type { GeneratedArtifact } from "../src/knowledge/types.js";

describe("ArtifactRevisionService", () => {
  it("validates and saves revised artifacts when a repository is provided", async () => {
    const artifact = makeArtifact("artifact-1");
    const revised = makeArtifact("artifact-revised", {
      content: "Built reporting dashboards.",
      metadata: {
        revision: {
          revisedFromArtifactId: artifact.id,
        },
        enhancement: {
          status: "ready",
          claims: [{
            text: "Built reporting dashboards.",
            supportLevel: "supported",
            riskLevel: "low",
            evidenceIds: ["ev-1"],
            sourceExperienceIds: ["exp-1"],
          }],
          confirmationQuestions: [],
          enhancementStrategy: "evidence_rewrite",
        },
      },
    });
    const repository = new FakeArtifactRepository();
    const service = new ArtifactRevisionService({
      revisionAgent: new FakeRevisionAgent(revised),
      artifactRepository: repository,
    });

    const result = await service.revise({
      userId: "user-1",
      artifact,
      instruction: "make_more_conservative",
    });

    expect(result.revisedArtifact.id).toBe("artifact-revised");
    expect(repository.saved).toEqual([revised]);
  });

  it("throws when the revision agent returns an invalid artifact", async () => {
    const artifact = makeArtifact("artifact-1");
    const invalid = {
      ...makeArtifact("artifact-invalid"),
      content: undefined,
    } as unknown as GeneratedArtifact;
    const service = new ArtifactRevisionService({
      revisionAgent: new FakeRevisionAgent(invalid),
    });

    await expect(service.revise({
      userId: "user-1",
      artifact,
      instruction: "make_more_conservative",
    })).rejects.toThrow(/GeneratedArtifact validation failed/);
  });
});

class FakeRevisionAgent implements ArtifactRevisionAgent {
  public constructor(private readonly revisedArtifact: GeneratedArtifact) {}

  public async revise(input: ArtifactRevisionInput): Promise<ArtifactRevisionResult> {
    return {
      originalArtifact: input.artifact,
      revisedArtifact: this.revisedArtifact,
      warnings: [],
    };
  }
}

class FakeArtifactRepository implements GeneratedArtifactRepository {
  public readonly saved: GeneratedArtifact[] = [];

  public async getById(_id: string): Promise<GeneratedArtifact | null> {
    return null;
  }

  public async getByExperienceId(_experienceId: string): Promise<GeneratedArtifact[]> {
    return [];
  }

  public async listByUserId(_userId: string): Promise<GeneratedArtifact[]> {
    return [];
  }

  public async save(artifact: GeneratedArtifact): Promise<void> {
    this.saved.push(artifact);
  }

  public async delete(_id: string): Promise<void> {}
}

function makeArtifact(id: string, params: Partial<GeneratedArtifact> = {}): GeneratedArtifact {
  return {
    id,
    userId: "user-1",
    type: "resume_bullet",
    content: "Original artifact.",
    sourceExperienceIds: ["exp-1"],
    sourceEvidenceIds: ["ev-1"],
    matchedSkillIds: [],
    targetJDId: "jd-1",
    targetRequirementIds: ["req-1"],
    targetRole: "BI Analyst",
    scores: { overall: 0.7, requirementMatch: 0.7, evidenceStrength: 0.8 },
    status: "ready",
    metadata: {},
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...params,
  };
}
