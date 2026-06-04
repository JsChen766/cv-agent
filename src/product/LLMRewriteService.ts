import { z } from "zod";
import type { ModelClient } from "../agent-core/model/ModelClient.js";
import { safeParseJsonOutput } from "../infrastructure/llm/JsonOutputParser.js";

const RewriteResultSchema = z.object({
  rewrittenText: z.string().min(1),
  changes: z.array(z.object({
    type: z.enum(["rewording", "restructuring", "quantification", "trimming", "expansion", "translation", "other"]),
    description: z.string(),
    original: z.string().optional(),
    rewritten: z.string().optional(),
  })).optional(),
  preservedFacts: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1),
  notes: z.string().optional(),
});

const RewritePreviewSchema = z.object({
  rewrittenText: z.string().min(1),
  sourceTextPreview: z.string(),
  changes: z.array(z.object({
    type: z.enum(["rewording", "restructuring", "quantification", "trimming", "expansion", "translation", "other"]),
    description: z.string(),
    original: z.string().optional(),
    rewritten: z.string().optional(),
  })).optional(),
  warnings: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const ClaimCheckResultSchema = z.object({
  claims: z.array(z.object({
    text: z.string(),
    supported: z.boolean(),
    sourceExperienceId: z.string().optional(),
    sourceEvidence: z.string().optional(),
    risk: z.enum(["low", "medium", "high"]).optional(),
  })),
  summary: z.object({
    totalClaims: z.number(),
    supportedClaims: z.number(),
    unsupportedClaims: z.number(),
    riskLevel: z.enum(["low", "medium", "high", "critical"]),
  }),
});

export type RewritePreview = z.infer<typeof RewritePreviewSchema>;
export type ClaimCheckResult = z.infer<typeof ClaimCheckResultSchema>;

const EXPERIENCE_REWRITE_SYSTEM = [
  "You are a professional resume editor. Rewrite the provided experience to improve its impact while preserving all factual claims.",
  "",
  "Rules:",
  "- Preserve ALL facts: company names, project names, metrics, numbers, dates, roles.",
  "- Do NOT invent new metrics, numbers, or achievements.",
  "- If the original lacks metrics, use conservative phrasing like 'contributed to' or 'helped improve'.",
  "- Improve clarity, impact, and structure.",
  "- Use the STAR method (Situation, Task, Action, Result) where applicable.",
  "- Output ONLY valid JSON.",
].join("\n");

const RESUME_ITEM_REWRITE_SYSTEM = [
  "You are a professional resume editor. Rewrite a single resume bullet point based on a specific instruction.",
  "",
  "Rules:",
  "- Only rewrite the content provided below.",
  "- Preserve ALL factual claims, metrics, and numbers from the original.",
  "- Do NOT invent new metrics, numbers, company names, or project names.",
  "- If the instruction asks for quantification but the original has no metrics, use conservative phrasing.",
  "- Output ONLY valid JSON with a 'rewrittenText' field.",
].join("\n");

const CLAIM_CHECK_SYSTEM = [
  "You are a resume fact-checker. Analyze the provided resume content against the candidate's experience library.",
  "",
  "Rules:",
  "- For each factual claim in the content, determine if it is supported by the experiences.",
  "- A claim is 'supported' if the experience library contains matching facts, metrics, company names, or project details.",
  "- A claim is 'unsupported' if no experience confirms it or if it appears to be fabricated.",
  "- Be conservative: if unsure, mark as 'unsupported'.",
  "- Output ONLY valid JSON.",
].join("\n");

export class LLMRewriteService {
  public constructor(private readonly modelClient: ModelClient) {}

  public async rewriteExperience(
    originalContent: string,
    instruction?: string,
    experienceContext?: { title?: string; organization?: string; role?: string },
  ): Promise<RewritePreview | null> {
    try {
      const contextParts = [
        experienceContext?.title ? `Title: ${experienceContext.title}` : "",
        experienceContext?.organization ? `Organization: ${experienceContext.organization}` : "",
        experienceContext?.role ? `Role: ${experienceContext.role}` : "",
      ].filter(Boolean);

      const userPrompt = [
        contextParts.length > 0 ? `Context:\n${contextParts.join("\n")}` : "",
        "",
        `Original experience:`,
        originalContent.slice(0, 3000),
        "",
        instruction ? `Instruction: ${instruction}` : "Please improve the clarity and impact of this experience.",
        "",
        "Return JSON with: rewrittenText, sourceTextPreview, changes, warnings, confidence.",
      ].join("\n");

      const response = await this.modelClient.chat({
        messages: [
          { role: "system", content: EXPERIENCE_REWRITE_SYSTEM },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        maxTokens: 4096,
        responseFormat: "json",
      });

      const parsed = parseJson(response.content);
      const validated = RewritePreviewSchema.safeParse(parsed);

      if (validated.success) {
        return {
          ...validated.data,
          sourceTextPreview: validated.data.sourceTextPreview || originalContent.slice(0, 200),
        };
      }

      // Repair attempt
      return await this.repairRewrite(
        EXPERIENCE_REWRITE_SYSTEM,
        userPrompt,
        validated.error.issues,
      );
    } catch {
      return null;
    }
  }

  public async rewriteResumeItem(
    sourceText: string,
    instruction: string,
  ): Promise<RewritePreview | null> {
    try {
      const userPrompt = [
        `Original resume item:`,
        sourceText,
        "",
        `Rewrite instruction: ${instruction}`,
        "",
        "Return JSON with: rewrittenText, sourceTextPreview, changes, warnings, confidence.",
      ].join("\n");

      const response = await this.modelClient.chat({
        messages: [
          { role: "system", content: RESUME_ITEM_REWRITE_SYSTEM },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        maxTokens: 2048,
        responseFormat: "json",
      });

      const parsed = parseJson(response.content);
      const validated = RewritePreviewSchema.safeParse(parsed);

      if (validated.success) {
        return {
          ...validated.data,
          sourceTextPreview: validated.data.sourceTextPreview || sourceText.slice(0, 200),
        };
      }

      return await this.repairRewrite(
        RESUME_ITEM_REWRITE_SYSTEM,
        userPrompt,
        validated.error.issues,
      );
    } catch {
      return null;
    }
  }

  public async checkClaims(
    content: string,
    experiences: Array<{ id: string; title: string; content: string; organization?: string; role?: string }>,
  ): Promise<ClaimCheckResult | null> {
    try {
      const expSection = experiences.length > 0
        ? experiences.map((exp) =>
            `[${exp.id}] ${exp.title}${exp.organization ? ` @ ${exp.organization}` : ""}${exp.role ? ` as ${exp.role}` : ""}\n${exp.content.slice(0, 500)}`
          ).join("\n\n")
        : "No experiences available for fact-checking.";

      const response = await this.modelClient.chat({
        messages: [
          { role: "system", content: CLAIM_CHECK_SYSTEM },
          {
            role: "user",
            content: [
              "Experience Library:",
              expSection,
              "",
              "Resume content to check:",
              content.slice(0, 4000),
              "",
              "Return JSON with claims array and summary.",
            ].join("\n"),
          },
        ],
        temperature: 0.1,
        maxTokens: 4096,
        responseFormat: "json",
      });

      const parsed = parseJson(response.content);
      const validated = ClaimCheckResultSchema.safeParse(parsed);

      if (validated.success) return validated.data;

      // Simple fallback
      return {
        claims: [],
        summary: {
          totalClaims: 0,
          supportedClaims: 0,
          unsupportedClaims: 0,
          riskLevel: experiences.length > 0 ? "medium" : "high",
        },
      };
    } catch {
      return null;
    }
  }

  private async repairRewrite(
    systemPrompt: string,
    userPrompt: string,
    issues: z.ZodIssue[],
  ): Promise<RewritePreview> {
    try {
      const errorSummary = issues
        .slice(0, 4)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("\n");

      const response = await this.modelClient.chat({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
          { role: "assistant", content: "[previous output had schema errors]" },
          { role: "user", content: `Fix the JSON. Errors: ${errorSummary}\nOutput only corrected JSON.` },
        ],
        temperature: 0.2,
        maxTokens: 4096,
        responseFormat: "json",
      });

      const parsed = parseJson(response.content);
      const validated = RewritePreviewSchema.safeParse(parsed);
      if (validated.success) return validated.data;
    } catch {
      // ignore repair failure
    }

    return {
      rewrittenText: userPrompt,
      sourceTextPreview: userPrompt.slice(0, 200),
      warnings: ["rewrite_failed"],
      confidence: 0,
    };
  }
}

function parseJson(content: string): unknown {
  const result = safeParseJsonOutput(content, { expected: "object" });
  return result.ok ? result.value : {};
}
