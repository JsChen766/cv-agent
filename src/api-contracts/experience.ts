import type {
  Evidence,
  EvidenceSourceType,
  Experience,
  ExperienceType,
  ExperienceVariant,
  Skill,
} from "../knowledge/types.js";

export type IngestExperienceRequest = {
  userId: string;
  rawText: string;
  sourceType?: EvidenceSourceType;
  sourceRef?: string;
};

export type IngestExperienceResponse = {
  experience: Experience;
  experiences: Experience[];
  evidences: Evidence[];
  skills: Skill[];
  warnings: string[];
};

export type ExperienceListItem = {
  id: string;
  title: string;
  type: ExperienceType;
  organization: string;
  role: string;
  summary: string;
  skillNames: string[];
  evidenceCount: number;
  confidence: number;
  updatedAt: string;
};

export type GetExperienceDetailResponse = {
  experience: Experience;
  evidences: Evidence[];
  skills: Skill[];
  variants: ExperienceVariant[];
};
