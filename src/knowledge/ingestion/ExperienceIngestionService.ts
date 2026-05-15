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
import { EvidenceCompletenessGuard } from "./EvidenceCompletenessGuard.js";

export type IngestExperienceInput = {
  userId: string;
  rawText: string;
  sourceRef?: string;
  sourceType?: EvidenceSourceType;
  sourceDocumentId?: string;
};

export type IngestExperienceResult = {
  experience: Experience;
  evidences: Evidence[];
  skills: Skill[];
};

export type { ExperienceExtractor } from "./extractors/types.js";

export class ExperienceIngestionService {
  private readonly extractor: ExperienceExtractor;
  private readonly evidenceCompletenessGuard: EvidenceCompletenessGuard;

  constructor(
    private readonly experienceRepo: ExperienceRepository,
    private readonly evidenceRepo: EvidenceRepository,
    private readonly skillRepo: SkillRepository,
    extractor: ExperienceExtractor = new DeterministicExperienceExtractor(),
    evidenceCompletenessGuard: EvidenceCompletenessGuard = new EvidenceCompletenessGuard(),
  ) {
    this.extractor = extractor;
    this.evidenceCompletenessGuard = evidenceCompletenessGuard;
  }

  async ingest(input: IngestExperienceInput): Promise<IngestExperienceResult> {
    const extracted = await this.extractor.extract(input);
    const completed = this.evidenceCompletenessGuard.complete({
      rawText: input.rawText,
      evidenceExcerpts: extracted.evidenceExcerpts,
    });
    const evidenceExcerpts = completed.evidenceExcerpts;
    const now = new Date().toISOString();
    const experienceId = stableId("exp", `${input.userId}:${input.rawText}`);

    const evidences = evidenceExcerpts.map((excerpt, index) => ({
      id: `${experienceId}-ev-${index + 1}`,
      userId: input.userId,
      experienceId,
      sourceType: input.sourceType ?? "raw_input",
      evidenceType: this.detectEvidenceType(excerpt),
      sourceRef: input.sourceRef ?? "raw-experience-input",
      excerpt,
      confidence: this.detectEvidenceConfidence(excerpt),
      ...(input.sourceDocumentId ? {
        sourceDocumentId: input.sourceDocumentId,
        metadata: { sourceDocumentId: input.sourceDocumentId },
      } : {}),
      createdAt: now,
    }));

    const skills = await this.upsertSkills(input.userId, input.rawText, evidences, now);

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
      star: this.buildStar({
        summary: extracted.summary,
        evidenceExcerpts,
        evidences,
      }),
      evidenceIds: evidences.map((e) => e.id),
      skillIds: skills.map((s) => s.id),
      confidence: evidences.length > 1 ? 0.82 : 0.68,
      ...(input.sourceDocumentId ? {
        sourceDocumentId: input.sourceDocumentId,
        metadata: { sourceDocumentId: input.sourceDocumentId },
      } : {}),
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
    if (this.scoreResultCandidate(excerpt) > 0) {
      return "result";
    }
    if (/\b(for|across)\s+\d+[\w\s-]*(teams|users|customers|products|projects|markets)\b/i.test(excerpt)) {
      return "scope";
    }
    if (this.scoreActionCandidate(excerpt) > 0) {
      return "action";
    }
    if (/\b(project|built|shipped|launched|library|system)\b/i.test(excerpt)) {
      return "project";
    }
    if (detectKnownSkills(excerpt).length > 0) {
      return "skill_proof";
    }
    if (/\d|%/.test(excerpt)) {
      return "metric";
    }
    return "raw_excerpt";
  }

  private detectEvidenceConfidence(excerpt: string): number {
    if (this.scoreResultCandidate(excerpt) > 0) {
      return 0.92;
    }
    if (/\d|%/.test(excerpt)) {
      return 0.86;
    }
    return excerpt.length > 40 ? 0.8 : 0.7;
  }

  private buildStar(input: {
    summary: string;
    evidenceExcerpts: string[];
    evidences: Evidence[];
  }): Experience["star"] {
    const excerpts = input.evidences.length > 0
      ? input.evidences.map((evidence) => evidence.excerpt)
      : input.evidenceExcerpts;
    const fallback = excerpts[0] ?? input.summary;

    const situation =
      this.pickBestEvidence(excerpts, (text) => this.scoreSituationCandidate(text)) ??
      fallback;
    const taskCandidate =
      this.pickBestEvidence(excerpts, (text) => this.scoreTaskCandidate(text)) ??
      excerpts[1] ??
      fallback;
    const actionFallback = excerpts.slice(1).join(" ") || fallback;
    const action =
      this.pickBestEvidence(excerpts, (text) => this.scoreActionCandidate(text)) ??
      actionFallback;
    const result =
      this.pickBestEvidence(excerpts, (text) => this.scoreResultCandidate(text)) ??
      this.pickResultFallback(excerpts, fallback);
    const task = this.sameText(taskCandidate, situation)
      ? this.pickTaskFallback({
        excerpts,
        situation,
        summary: input.summary,
      })
      : taskCandidate;

    return { situation, task, action, result };
  }

  private pickTaskFallback(input: {
    excerpts: string[];
    situation: string;
    summary: string;
  }): string {
    const actionEvidence =
      this.pickBestEvidence(input.excerpts, (text) => this.scoreActionCandidate(text)) ??
      input.excerpts.find((excerpt) => !this.sameText(excerpt, input.situation));
    if (actionEvidence) {
      return this.synthesizeTaskFromAction(
        actionEvidence,
        [input.summary, input.situation, ...input.excerpts].join(" "),
      );
    }

    const summaryTask = this.synthesizeTaskFromAction(input.summary, input.summary);
    if (!this.sameText(summaryTask, input.situation)) {
      return summaryTask;
    }
    return "Support the related project goals described in the experience.";
  }

  private synthesizeTaskFromAction(actionEvidence: string, context: string): string {
    const objective = this.toImperativeObjective(actionEvidence);
    if (
      /\bcomponent library\b/i.test(objective) &&
      /\bdesign system\b/i.test(context)
    ) {
      return `${objective} and support the related design system work.`;
    }
    return `${objective}.`;
  }

  private toImperativeObjective(text: string): string {
    const cleaned = text
      .trim()
      .replace(/[.!?]+$/, "")
      .replace(/\s+\b(?:using|through|with)\b.*$/i, "");
    const replacements: Array<[RegExp, string]> = [
      [/^built\b/i, "Build"],
      [/^implemented\b/i, "Implement"],
      [/^created\b/i, "Create"],
      [/^optimized\b/i, "Optimize"],
      [/^integrated\b/i, "Integrate"],
      [/^launched\b/i, "Launch"],
      [/^designed\b/i, "Design"],
      [/^shipped\b/i, "Ship"],
      [/^developed\b/i, "Develop"],
      [/^led\b/i, "Lead"],
      [/^owned\b/i, "Own"],
      [/^managed\b/i, "Manage"],
      [/^coordinated\b/i, "Coordinate"],
    ];

    for (const [pattern, replacement] of replacements) {
      if (pattern.test(cleaned)) {
        return cleaned.replace(pattern, replacement);
      }
    }
    return `Support ${cleaned.charAt(0).toLowerCase()}${cleaned.slice(1)}`;
  }

  private pickResultFallback(excerpts: string[], fallback: string): string {
    const nonSituation = [...excerpts]
      .reverse()
      .find((excerpt) => this.scoreSituationCandidate(excerpt) === 0);
    return nonSituation ?? excerpts.at(-1) ?? fallback;
  }

  private pickBestEvidence(
    excerpts: string[],
    scorer: (text: string) => number,
  ): string | null {
    let best: { excerpt: string; score: number } | null = null;
    for (const excerpt of excerpts) {
      const score = scorer(excerpt);
      if (score <= 0) {
        continue;
      }
      if (!best || score > best.score) {
        best = { excerpt, score };
      }
    }
    return best?.excerpt ?? null;
  }

  private scoreSituationCandidate(text: string): number {
    let score = 0;
    if (/\bas\s+(?:a|an)\b/i.test(text)) score += 2;
    if (/\bat\s+[A-Z][\w\s&.-]+/i.test(text)) score += 2;
    if (/\b(for|across)\s+\d+[\w\s-]*(teams|users|customers|products|projects|markets)\b/i.test(text)) score += 2;
    if (/\bproject\s+for\b/i.test(text)) score += 1;
    return score;
  }

  private scoreTaskCandidate(text: string): number {
    let score = 0;
    if (/\b(led|owned|responsible for|tasked with|managed|coordinated)\b/i.test(text)) score += 2;
    if (/\b(scope|initiative|program|project|design system|component library)\b/i.test(text)) score += 1;
    return score;
  }

  private scoreActionCandidate(text: string): number {
    let score = 0;
    if (/\b(built|implemented|created|optimized|integrated|launched|designed|shipped|developed)\b/i.test(text)) score += 2;
    if (/\b(using|through|with)\b/i.test(text)) score += 1;
    return score;
  }

  private scoreResultCandidate(text: string): number {
    let score = 0;
    if (/\b(reduced|improved|increased|decreased|saved|achieved|delivered|grew|lowered|raised)\b/i.test(text)) score += 3;
    if (/%|\bby\s+\d+|\bfrom\s+.+\s+to\s+.+/i.test(text)) score += 2;
    if (/\b(result|outcome|impact)\b/i.test(text)) score += 1;
    return score;
  }

  private sameText(a: string, b: string): boolean {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
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
