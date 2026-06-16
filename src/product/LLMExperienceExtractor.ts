import { z } from "zod";
import type { ModelClient } from "../agent-core/model/ModelClient.js";
import { PromptRegistry } from "../agent-core/prompts/PromptRegistry.js";
import { safeParseJsonOutput } from "../infrastructure/llm/JsonOutputParser.js";
import type { ProductExperienceCategory } from "./types.js";

const WorkExperienceSchema = z.object({
  type: z.literal("work"),
  title: z.string().min(1),
  company: z.string().optional(),
  role: z.string().optional(),
  department: z.string().optional(),
  employmentType: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  achievements: z.array(z.string()).optional(),
  metrics: z.array(z.object({ name: z.string(), value: z.string(), context: z.string().optional() })).optional(),
  skills: z.array(z.string()).optional(),
  content: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
});

const InternshipExperienceSchema = WorkExperienceSchema.extend({
  type: z.literal("internship"),
});

const ProjectExperienceSchema = z.object({
  type: z.literal("project"),
  title: z.string().min(1),
  projectName: z.string().optional(),
  projectRole: z.string().optional(),
  techStack: z.array(z.string()).optional(),
  projectUrl: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  responsibilities: z.array(z.string()).optional(),
  outcomes: z.array(z.string()).optional(),
  metrics: z.array(z.object({ name: z.string(), value: z.string(), context: z.string().optional() })).optional(),
  content: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
});

const EducationExperienceSchema = z.object({
  type: z.literal("education"),
  title: z.string().min(1),
  school: z.string().optional(),
  degree: z.string().optional(),
  major: z.string().optional(),
  gpa: z.string().optional(),
  courses: z.array(z.string()).optional(),
  honors: z.array(z.string()).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  content: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
});

const AwardExperienceSchema = z.object({
  type: z.literal("award"),
  title: z.string().min(1),
  awardName: z.string().optional(),
  issuer: z.string().optional(),
  level: z.string().optional(),
  awardDate: z.string().optional(),
  description: z.string().optional(),
  content: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
});

const SkillExperienceSchema = z.object({
  type: z.literal("skill"),
  title: z.string().min(1),
  skillCategory: z.string().optional(),
  skills: z.array(z.string()).optional(),
  proficiency: z.string().optional(),
  evidence: z.array(z.string()).optional(),
  content: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
});

const ExtractedCandidateSchema = z.discriminatedUnion("type", [
  WorkExperienceSchema,
  InternshipExperienceSchema,
  ProjectExperienceSchema,
  EducationExperienceSchema,
  AwardExperienceSchema,
  SkillExperienceSchema,
]);

const ExtractionResultSchema = z.object({
  candidates: z.array(ExtractedCandidateSchema).min(1).max(20),
});

export type ExtractedCandidate = z.infer<typeof ExtractedCandidateSchema>;
type ExtractionResult = z.infer<typeof ExtractionResultSchema>;
export type DominantLanguage = "zh" | "en" | "mixed";

const PROMPTS = new PromptRegistry();
const SYSTEM_PROMPT = PROMPTS.get("product.experienceExtraction.system");

export function detectDominantLanguage(text: string): DominantLanguage {
  const cjkCount = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  const asciiLetterCount = (text.match(/[A-Za-z]/g) ?? []).length;
  const chinesePunctuationCount = (text.match(/[，。！？、；：“”‘’《》（）]/g) ?? []).length;
  const significantCjk = cjkCount >= 4 || (cjkCount > 0 && chinesePunctuationCount > 0);

  if (significantCjk && asciiLetterCount > 0) {
    return cjkCount + chinesePunctuationCount >= Math.max(4, asciiLetterCount * 0.18) ? "zh" : "mixed";
  }
  if (significantCjk || cjkCount > 0) return "zh";
  if (asciiLetterCount > 0) return "en";
  return "mixed";
}

export function buildUserPrompt(text: string): string {
  const truncated = text.length > 8000 ? text.slice(0, 8000) + "\n...[truncated]" : text;
  const inputLanguage = detectDominantLanguage(text);
  return [
    "Extract all experiences from the following text. Return a JSON object with a 'candidates' array.",
    `Detected input language: ${inputLanguage}.`,
    "",
    "Language requirement:",
    "- Use the dominant language of the input text for all user-facing output fields.",
    "- Do not translate the user's experience into another language unless explicitly requested.",
    "- Keep proper nouns, paper titles, journal names, company names, school names, product names, model names, and technical terms in their original language.",
    "- If the detected language is zh, write explanatory resume text in Chinese while preserving English proper nouns.",
    "- If the detected language is en, write explanatory resume text in English.",
    "- This may be a complete resume. Extract education, internship/work, each project, awards/certificates, and skills as separate candidates.",
    "- Do not merge the whole resume into one candidate. Do not stop after the first candidate.",
    "- Every candidate must include a category via the 'type' field.",
    "",
    "```text",
    truncated,
    "```",
    "",
    "Output JSON:",
  ].join("\n");
}

const REPAIR_PROMPT = PROMPTS.get("product.experienceExtraction.repair");

export class LLMExperienceExtractor {
  public constructor(private readonly modelClient: ModelClient) {}

  public async extractCandidates(text: string): Promise<ExtractedCandidate[]> {
    const result = await this.tryExtract(text);
    if (result.candidates.length === 1 && looksLikeMultiExperienceResume(text)) {
      const repaired = await this.repairExtraction(text, [
        "Only one candidate was returned, but the source text appears to contain multiple resume sections, dates, or projects. Split the complete resume into separate candidates.",
      ]);
      if (repaired.candidates.length > 1) return repaired.candidates;
    }
    return result.candidates;
  }

  private async tryExtract(text: string): Promise<ExtractionResult> {
    try {
      const response = await this.modelClient.chat({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(text) },
        ],
        temperature: 0.2,
        maxTokens: 4096,
        responseFormat: "json",
      });

      const parsed = this.parseJsonResponse(response.content);
      const validated = ExtractionResultSchema.safeParse(parsed);

      if (validated.success) {
        return validated.data;
      }

      // Repair attempt
      return await this.repairExtraction(text, validated.error.issues);
    } catch {
      return { candidates: [] };
    }
  }

  private async repairExtraction(
    text: string,
    issues: z.ZodIssue[] | string[],
  ): Promise<ExtractionResult> {
    try {
      const errorSummary = issues
        .slice(0, 6)
        .map((issue) => typeof issue === "string" ? issue : `${issue.path.join(".")}: ${issue.message}`)
        .join("\n");

      const repairMessage = REPAIR_PROMPT.replace("{{errors}}", errorSummary);

      const response = await this.modelClient.chat({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(text) },
          { role: "assistant", content: "[previous output had schema errors]" },
          { role: "user", content: repairMessage },
        ],
        temperature: 0.2,
        maxTokens: 4096,
        responseFormat: "json",
      });

      const parsed = this.parseJsonResponse(response.content);
      const validated = ExtractionResultSchema.safeParse(parsed);

      if (validated.success) {
        return validated.data;
      }

      // Fallback: try to extract whatever valid candidates exist
      return this.extractValidCandidates(parsed);
    } catch {
      return { candidates: [] };
    }
  }

  private extractValidCandidates(raw: unknown): ExtractionResult {
    if (typeof raw !== "object" || raw === null) {
      return { candidates: [] };
    }
    const obj = raw as Record<string, unknown>;
    if (!Array.isArray(obj.candidates)) {
      return { candidates: [] };
    }
    const validCandidates: ExtractedCandidate[] = [];
    for (const candidate of obj.candidates) {
      const result = ExtractedCandidateSchema.safeParse(candidate);
      if (result.success) {
        validCandidates.push(result.data);
      }
    }
    return { candidates: validCandidates };
  }

  private parseJsonResponse(content: string): unknown {
    const result = safeParseJsonOutput(content, { expected: "object" });
    return result.ok ? result.value : {};
  }
}

export function extractedCandidateToDraft(
  candidate: ExtractedCandidate,
  inputLanguage?: DominantLanguage,
): {
  category: ProductExperienceCategory;
  title: string;
  organization?: string;
  role?: string;
  startDate?: string;
  endDate?: string;
  content: string;
  tags: string[];
  structured: Record<string, unknown>;
  confidence: number;
  warnings: string[];
} {
  const warnings: string[] = [];
  const base = {
    confidence: candidate.confidence ?? 0.5,
    warnings,
  };
  const languageMeta = inputLanguage ? { inputLanguage } : {};

  switch (candidate.type) {
    case "work":
    case "internship":
      if (!candidate.company) warnings.push("organization_not_found");
      if (!candidate.role) warnings.push("role_not_found");
      return {
        ...base,
        category: candidate.type === "internship" ? "internship" : "work",
        title: candidate.title,
        organization: candidate.company,
        role: candidate.role,
        startDate: candidate.startDate,
        endDate: candidate.endDate,
        content: candidate.content,
        tags: candidate.skills ?? [],
        structured: {
          ...languageMeta,
          summary: candidate.content.slice(0, 200),
          highlights: candidate.achievements ?? [],
          metrics: candidate.metrics ?? [],
          company: candidate.company,
          department: candidate.department,
          employmentType: candidate.employmentType,
          rawText: candidate.content,
        },
      };

    case "project":
      if (!candidate.projectName) warnings.push("project_name_not_found");
      if (!(candidate.techStack?.length)) warnings.push("project_tech_stack_not_found");
      return {
        ...base,
        category: "project",
        title: candidate.title,
        organization: candidate.projectName,
        role: candidate.projectRole,
        startDate: candidate.startDate,
        endDate: candidate.endDate,
        content: candidate.content,
        tags: candidate.techStack ?? [],
        structured: {
          ...languageMeta,
          summary: candidate.content.slice(0, 200),
          highlights: [...(candidate.responsibilities ?? []), ...(candidate.outcomes ?? [])],
          metrics: candidate.metrics ?? [],
          projectName: candidate.projectName,
          projectRole: candidate.projectRole,
          techStack: candidate.techStack ?? [],
          projectUrl: candidate.projectUrl,
          startDate: candidate.startDate,
          endDate: candidate.endDate,
          rawText: candidate.content,
        },
      };

    case "education":
      if (!candidate.school) warnings.push("school_not_found");
      if (!candidate.major && !candidate.degree) warnings.push("major_or_degree_not_found");
      return {
        ...base,
        category: "education",
        title: candidate.title,
        organization: candidate.school,
        role: undefined,
        startDate: candidate.startDate,
        endDate: candidate.endDate,
        content: candidate.content,
        tags: [],
        structured: {
          ...languageMeta,
          summary: candidate.content.slice(0, 200),
          highlights: [],
          metrics: [],
          school: candidate.school,
          major: candidate.major,
          degree: candidate.degree,
          gpa: candidate.gpa,
          courses: candidate.courses ?? [],
          honors: candidate.honors ?? [],
          rawText: candidate.content,
        },
      };

    case "award":
      if (!candidate.issuer) warnings.push("award_issuer_not_found");
      return {
        ...base,
        category: "award",
        title: candidate.title,
        organization: candidate.issuer,
        role: undefined,
        startDate: candidate.awardDate,
        endDate: undefined,
        content: candidate.content,
        tags: [],
        structured: {
          ...languageMeta,
          summary: candidate.content.slice(0, 200),
          highlights: [],
          metrics: [],
          issuer: candidate.issuer,
          level: candidate.level,
          awardDate: candidate.awardDate,
          rawText: candidate.content,
        },
      };

    case "skill":
      if (!candidate.skillCategory) warnings.push("skill_category_not_found");
      return {
        ...base,
        category: "skill",
        title: candidate.title,
        organization: undefined,
        role: undefined,
        startDate: undefined,
        endDate: undefined,
        content: candidate.content,
        tags: candidate.skills ?? [],
        structured: {
          ...languageMeta,
          summary: candidate.content.slice(0, 200),
          highlights: [],
          metrics: [],
          skillCategory: candidate.skillCategory,
          proficiency: candidate.proficiency,
          evidence: candidate.evidence ?? [],
          rawText: candidate.content,
        },
      };

    default: {
      // All discriminated union members handled above; this is unreachable.
      const c = candidate as { title: string; content: string };
      return {
        ...base,
        category: "other" as ProductExperienceCategory,
        title: c.title,
        content: c.content,
        tags: [],
        structured: { ...languageMeta, rawText: c.content },
      };
    }
  }
}

export function looksLikeMultiExperienceResume(text: string): boolean {
  const normalized = String(text ?? "");
  const sectionHits = [
    /教育经历|教育背景|Education/i,
    /实习经历|工作经历|工作经验|Internship|Work Experience/i,
    /项目经历|项目经验|Projects?/i,
    /获奖经历|荣誉奖项|Awards?|Honors?/i,
    /技能|技能栈|Skills?|Certificates?/i,
  ].reduce((count, pattern) => count + (pattern.test(normalized) ? 1 : 0), 0);
  const dateHits = (normalized.match(/\b20\d{2}(?:[./-]\d{1,2})?\s*(?:-|–|—|~|至|到|to)\s*(?:20\d{2}(?:[./-]\d{1,2})?|至今|现在|present|current)\b/gi) ?? []).length;
  const projectHits = (normalized.match(/项目[一二三四五六七八九十\d]?[:：]|Project\s*\d*[:：-]/gi) ?? []).length;
  return sectionHits >= 2 || dateHits >= 2 || projectHits >= 2;
}
