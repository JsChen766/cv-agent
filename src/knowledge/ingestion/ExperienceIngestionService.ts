import type {
  Evidence,
  EvidenceSourceType,
  EvidenceType,
  Experience,
  Skill,
} from "../types.js";
import type {
  EvidenceRepository,
  ExperienceRepository,
  SkillRepository,
} from "../repositories.js";
import {
  detectKnownSkills,
  skillIdFor,
  stableId,
} from "../keywordUtils.js";
import {
  validateEvidence,
  validateExperience,
  validateSkill,
} from "../schemas/index.js";
import { DeterministicExperienceExtractor } from "./extractors/DeterministicExperienceExtractor.js";
import type { ExperienceExtractor } from "./extractors/types.js";

export type IngestExperienceInput = {
  userId: string;
  rawText: string;
  sourceRef?: string;
  sourceType?: EvidenceSourceType;
};

export type IngestExperienceResult = {
  experience: Experience;
  evidences: Evidence[];
  skills: Skill[];
};

export type { ExperienceExtractor } from "./extractors/types.js";

export class ExperienceIngestionService {
  private readonly extractor: ExperienceExtractor;

  constructor(
    private readonly experienceRepo: ExperienceRepository,
    private readonly evidenceRepo: EvidenceRepository,
    private readonly skillRepo: SkillRepository,
    extractor: ExperienceExtractor = new DeterministicExperienceExtractor(),
  ) {
    this.extractor = extractor;
  }

  async ingest(input: IngestExperienceInput): Promise<IngestExperienceResult> {
    const extracted = await this.extractor.extract(input);
    const now = new Date().toISOString();
    const experienceId = stableId("exp", `${input.userId}:${input.rawText}`);

    const evidences = extracted.evidenceExcerpts.map((excerpt, index) => ({
      id: `${experienceId}-ev-${index + 1}`,
      userId: input.userId,
      experienceId,
      sourceType: input.sourceType ?? "raw_input",
      evidenceType: this.detectEvidenceType(excerpt),
      sourceRef: input.sourceRef ?? "raw-experience-input",
      excerpt,
      confidence: this.detectEvidenceConfidence(excerpt),
      createdAt: now,
    }));

    const skills = await this.upsertSkills(input.userId, input.rawText, evidences, now);
    const resultExcerpt = evidences.find((e) => e.evidenceType === "metric")?.excerpt;

    const experience: Experience = {
      id: experienceId,
      userId: input.userId,
      type: extracted.type,
      organization: extracted.organization,
      role: extracted.role,
      summary: extracted.summary,
      timeRange: {
        startDate: null,
        endDate: null,
      },
      star: {
        situation: extracted.summary,
        task: extracted.evidenceExcerpts[1] ?? extracted.summary,
        action: extracted.evidenceExcerpts.slice(1).join(" "),
        result: resultExcerpt ?? extracted.evidenceExcerpts.at(-1) ?? extracted.summary,
      },
      evidenceIds: evidences.map((e) => e.id),
      skillIds: skills.map((s) => s.id),
      confidence: evidences.length > 1 ? 0.82 : 0.68,
      createdAt: now,
      updatedAt: now,
    };

    validateExperience(experience);
    await this.experienceRepo.save(experience);
    for (const evidence of evidences) {
      validateEvidence(evidence);
      await this.evidenceRepo.save(evidence);
    }

    return { experience, evidences, skills };
  }

  private detectEvidenceType(excerpt: string): EvidenceType {
    if (/\d|%/.test(excerpt)) {
      return "metric";
    }
    if (/\b(project|built|shipped|launched|library|system)\b/i.test(excerpt)) {
      return "project";
    }
    if (/\b(result|reduced|increased|improved)\b/i.test(excerpt)) {
      return "outcome";
    }
    return "bullet";
  }

  private detectEvidenceConfidence(excerpt: string): number {
    if (/\d|%/.test(excerpt)) {
      return 0.92;
    }
    return excerpt.length > 40 ? 0.8 : 0.7;
  }

  private async upsertSkills(
    userId: string,
    rawText: string,
    evidences: Evidence[],
    now: string,
  ): Promise<Skill[]> {
    const detected = detectKnownSkills(rawText);
    const skills: Skill[] = [];

    for (const detectedSkill of detected) {
      const existing = await this.skillRepo.findByName(userId, detectedSkill.name);
      const evidenceIds = evidences
        .filter((e) => this.evidenceMentionsSkill(e.excerpt, detectedSkill.name))
        .map((e) => e.id);

      if (existing) {
        const merged: Skill = {
          ...existing,
          evidenceIds: Array.from(new Set([...existing.evidenceIds, ...evidenceIds])),
          updatedAt: now,
        };
        await this.skillRepo.save(merged);
        skills.push(merged);
        continue;
      }

      const skill: Skill = {
        id: skillIdFor(userId, detectedSkill.name),
        userId,
        name: detectedSkill.name,
        category: detectedSkill.category,
        evidenceIds,
        createdAt: now,
        updatedAt: now,
      };
      await this.skillRepo.save(skill);
      skills.push(skill);
    }

    for (const skill of skills) {
      validateSkill(skill);
    }
    return skills;
  }

  private evidenceMentionsSkill(excerpt: string, skillName: string): boolean {
    const normalized = excerpt.toLowerCase();
    return detectKnownSkills(normalized).some((skill) => skill.name === skillName);
  }
}
