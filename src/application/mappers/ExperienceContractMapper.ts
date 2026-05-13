import type {
  ExperienceListItem,
  IngestExperienceResponse,
} from "../../api-contracts/experience.js";
import type { IngestExperienceResult } from "../../knowledge/ingestion/ExperienceIngestionService.js";
import type { Evidence, Experience, Skill } from "../../knowledge/types.js";

export function toIngestExperienceResponse(
  result: IngestExperienceResult,
): IngestExperienceResponse {
  return {
    experience: result.experience,
    evidences: result.evidences,
    skills: result.skills,
    warnings: [],
  };
}

export function toExperienceListItem(input: {
  experience: Experience;
  skills: Skill[];
  evidences: Evidence[];
}): ExperienceListItem {
  return {
    id: input.experience.id,
    title: `${input.experience.role} · ${input.experience.organization}`,
    type: input.experience.type,
    organization: input.experience.organization,
    role: input.experience.role,
    summary: input.experience.summary,
    skillNames: input.skills.map((skill) => skill.name),
    evidenceCount: input.evidences.length,
    confidence: input.experience.confidence,
    updatedAt: input.experience.updatedAt,
  };
}
