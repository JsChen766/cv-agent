import type {
  Evidence,
  EvidenceSourceType,
  EvidenceType,
  Experience,
  ExperienceType,
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
  splitEvidenceText,
  stableId,
} from "../keywordUtils.js";
import {
  validateEvidence,
  validateExperience,
  validateSkill,
} from "../schemas/index.js";

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

type ExtractedExperience = {
  type: ExperienceType;
  organization: string;
  role: string;
  summary: string;
  evidenceExcerpts: string[];
};

export interface ExperienceExtractor {
  extract(input: IngestExperienceInput): ExtractedExperience;
}

class DeterministicExperienceExtractor implements ExperienceExtractor {
  extract(input: IngestExperienceInput): ExtractedExperience {
    const evidenceExcerpts = splitEvidenceText(input.rawText).slice(0, 5);
    const firstExcerpt = evidenceExcerpts[0] ?? input.rawText.trim();

    return {
      type: this.detectType(input.rawText),
      organization: this.detectOrganization(input.rawText),
      role: this.detectRole(input.rawText),
      summary: firstExcerpt,
      evidenceExcerpts: evidenceExcerpts.length > 0 ? evidenceExcerpts : [input.rawText.trim()],
    };
  }

  private detectType(text: string): ExperienceType {
    const normalized = text.toLowerCase();
    if (normalized.includes("university") || normalized.includes("course")) {
      return "education";
    }
    if (normalized.includes("project") || normalized.includes("built")) {
      return "project";
    }
    return "work";
  }

  private detectOrganization(text: string): string {
    const atMatch = text.match(/\bat\s+([A-Z][A-Za-z0-9&.\-\s]{1,40})/);
    return atMatch?.[1]?.trim().replace(/[.,;:]$/, "") ?? "Unknown Organization";
  }

  private detectRole(text: string): string {
    const roleMatch = text.match(/\bas\s+(?:a|an)?\s*([A-Za-z][A-Za-z0-9&.\-\s]{1,40})\s+at\b/i);
    if (roleMatch?.[1]) {
      return roleMatch[1].trim();
    }
    if (/\b(frontend|react|typescript|component)\b/i.test(text)) {
      return "Frontend Engineer";
    }
    return "Contributor";
  }
}

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
    const extracted = this.extractor.extract(input);
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
