import type { JDRequirement } from "../../knowledge/types.js";
import type { GeneratedArtifact } from "../../knowledge/types.js";
import type { RetrievedExperience } from "../../knowledge/retrieval/ExperienceRetriever.js";

export type GenerateArtifactsInput = {
  userId: string;
  jdId: string;
  jdText: string;
  targetRole: string;
  requirements: JDRequirement[];
  retrievedExperiences: RetrievedExperience[];
};

export interface ArtifactGenerator {
  generate(input: GenerateArtifactsInput): Promise<GeneratedArtifact[]>;
}
