import type {
  Evidence,
  Experience,
  ExperienceVariant,
  GeneratedArtifact,
  JDRequirement,
  Skill,
} from "./types.js";

export interface ExperienceRepository {
  getById(id: string): Promise<Experience | null>;
  list(): Promise<Experience[]>;
  listByUserId(userId: string): Promise<Experience[]>;
  save(experience: Experience): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface EvidenceRepository {
  getById(id: string): Promise<Evidence | null>;
  getByExperienceId(experienceId: string): Promise<Evidence[]>;
  listByUserId(userId: string): Promise<Evidence[]>;
  save(evidence: Evidence): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface GeneratedArtifactRepository {
  getById(id: string): Promise<GeneratedArtifact | null>;
  getByExperienceId(experienceId: string): Promise<GeneratedArtifact[]>;
  listByUserId(userId: string): Promise<GeneratedArtifact[]>;
  save(artifact: GeneratedArtifact): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface SkillRepository {
  getById(id: string): Promise<Skill | null>;
  findByName(userId: string, name: string): Promise<Skill | null>;
  listByUserId(userId: string): Promise<Skill[]>;
  save(skill: Skill): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface JDRequirementRepository {
  getById(id: string): Promise<JDRequirement | null>;
  listByUserId(userId: string): Promise<JDRequirement[]>;
  listByJDId(userId: string, jdId: string): Promise<JDRequirement[]>;
  save(requirement: JDRequirement): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface ExperienceVariantRepository {
  getById(id: string): Promise<ExperienceVariant | null>;
  getByExperienceId(experienceId: string): Promise<ExperienceVariant[]>;
  listByUserId(userId: string): Promise<ExperienceVariant[]>;
  save(variant: ExperienceVariant): Promise<void>;
  delete(id: string): Promise<void>;
}
