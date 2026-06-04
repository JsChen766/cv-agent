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
  ProjectExperienceSchema,
  EducationExperienceSchema,
  AwardExperienceSchema,
  SkillExperienceSchema,
]);

const ExtractionResultSchema = z.object({
  candidates: z.array(ExtractedCandidateSchema).min(1).max(12),
});

export type ExtractedCandidate = z.infer<typeof ExtractedCandidateSchema>;
type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

const PROMPTS = new PromptRegistry();
const SYSTEM_PROMPT = PROMPTS.get("product.experienceExtraction.system");

function buildUserPrompt(text: string): string {
  const truncated = text.length > 8000 ? text.slice(0, 8000) + "\n...[truncated]" : text;
  return [
    "Extract all experiences from the following text. Return a JSON object with a 'candidates' array.",
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
    issues: z.ZodIssue[],
  ): Promise<ExtractionResult> {
    try {
      const errorSummary = issues
        .slice(0, 6)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
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

  switch (candidate.type) {
    case "work":
      if (!candidate.company) warnings.push("organization_not_found");
      if (!candidate.role) warnings.push("role_not_found");
      return {
        ...base,
        category: "work",
        title: candidate.title,
        organization: candidate.company,
        role: candidate.role,
        startDate: candidate.startDate,
        endDate: candidate.endDate,
        content: candidate.content,
        tags: candidate.skills ?? [],
        structured: {
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
        structured: { rawText: c.content },
      };
    }
  }
}
