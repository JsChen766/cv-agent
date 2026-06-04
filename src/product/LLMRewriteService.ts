import { z } from "zod";
import type { ModelClient } from "../agent-core/model/ModelClient.js";
import { PromptRegistry } from "../agent-core/prompts/PromptRegistry.js";
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

const PROMPTS = new PromptRegistry();
const EXPERIENCE_REWRITE_SYSTEM = PROMPTS.get("product.rewrite.experienceSystem");
const RESUME_ITEM_REWRITE_SYSTEM = PROMPTS.get("product.rewrite.resumeItemSystem");
const CLAIM_CHECK_SYSTEM = PROMPTS.get("product.rewrite.claimCheckSystem");

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
