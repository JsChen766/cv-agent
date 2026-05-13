import type { Experience, Evidence, GeneratedArtifact } from "./types.js";

export interface ExperienceRepository {
  getById(id: string): Promise<Experience | null>;
  list(): Promise<Experience[]>;
  save(experience: Experience): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface EvidenceRepository {
  getById(id: string): Promise<Evidence | null>;
  getByExperienceId(experienceId: string): Promise<Evidence[]>;
  save(evidence: Evidence): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface GeneratedArtifactRepository {
  getById(id: string): Promise<GeneratedArtifact | null>;
  getByExperienceId(experienceId: string): Promise<GeneratedArtifact[]>;
  save(artifact: GeneratedArtifact): Promise<void>;
  delete(id: string): Promise<void>;
}
