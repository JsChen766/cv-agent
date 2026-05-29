import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ModelClient } from "../agent-core/model/ModelClient.js";
import type { ProductExperienceSummary, ProductGeneratedVariant } from "./types.js";

const GeneratedVariantSchema = z.object({
  content: z.string().min(1),
  score: z.object({
    overall: z.number().min(0).max(1),
    relevance: z.number().min(0).max(1),
    evidenceStrength: z.number().min(0).max(1),
    quantifiedImpact: z.number().min(0).max(1).optional(),
    clarity: z.number().min(0).max(1).optional(),
  }),
  reason: z.string().min(1),
  sourceExperienceIds: z.array(z.string()).optional(),
  evidenceSummary: z.object({
    coverageLabel: z.string(),
    items: z.array(z.object({
      id: z.string(),
      title: z.string(),
      explanation: z.string(),
      confidence: z.number().min(0).max(1),
    })),
  }).optional(),
  riskSummary: z.object({
    level: z.enum(["low", "medium", "high", "critical"]),
    unsupportedClaims: z.array(z.string()).optional(),
    missingEvidence: z.array(z.string()).optional(),
    warnings: z.array(z.string()).optional(),
  }).optional(),
  missingInfo: z.array(z.string()).optional(),
});

const GenerationResultSchema = z.object({
  variants: z.array(GeneratedVariantSchema).min(1).max(5),
});

const SYSTEM_PROMPT = [
  "You are a professional resume writer. Generate tailored resume content based on a job description and the candidate's experience library.",
  "",
  "Rules:",
  "- Each variant should present the candidate differently (different emphasis, structure, or angle).",
  "- ONLY use facts, metrics, and experiences that are present in the provided experience library.",
  "- Do NOT invent company names, project names, metrics, or achievements that are not in the source experiences.",
  "- If an experience has metrics, use them. If not, use conservative phrasing like 'contributed to' rather than making up numbers.",
  "- For each variant, specify which source experiences were used (sourceExperienceIds).",
  "- Score each variant: overall, relevance (to JD), evidenceStrength (how well facts are supported), clarity.",
  "- Provide an evidenceSummary mapping claims to sources.",
  "- Provide a riskSummary: level (low/medium/high/critical), unsupportedClaims, missingEvidence, warnings.",
  "- List missingInfo: what the candidate should verify or add.",
  "- If no experiences match the JD, the risk level should be 'high' or 'critical' and the content should clearly state this.",
  "- Output ONLY valid JSON. No markdown, no explanation.",
].join("\n");

function buildUserPrompt(
  jdText: string,
  targetRole: string | undefined,
  experiences: ProductExperienceSummary[],
): string {
  const expSection = experiences.length > 0
    ? experiences.map((exp, i) => {
        const parts = [
          `[${exp.id}] ${exp.title}`,
          exp.organization ? `@ ${exp.organization}` : "",
          exp.role ? `as ${exp.role}` : "",
          exp.startDate || exp.endDate ? `(${exp.startDate ?? "?"} - ${exp.endDate ?? "?"})` : "",
          "",
          exp.content ? exp.content.slice(0, 600) : "",
        ];
        return parts.filter(Boolean).join(" ");
      }).join("\n\n")
    : "NO EXPERIENCES AVAILABLE. The candidate has not added any experiences yet.";

  return [
    targetRole ? `Target role: ${targetRole}` : "",
    "",
    "Job Description:",
    jdText.slice(0, 4000),
    "",
    "Candidate Experience Library:",
    expSection,
    "",
    "Generate resume content variants. Return a JSON object with a 'variants' array.",
  ].join("\n");
}

const REPAIR_PROMPT = [
  "The previous output failed JSON schema validation.",
  "Errors: {{errors}}",
  "",
  "Please fix the issues and return a valid JSON object with a 'variants' array.",
  "Each variant must have: content, score (overall, relevance, evidenceStrength), reason.",
  "Output ONLY the corrected JSON.",
].join("\n");

export class LLMGenerationService {
  public constructor(private readonly modelClient: ModelClient) {}

  public async generateVariants(
    userId: string,
    jdText: string,
    targetRole: string | undefined,
    experiences: ProductExperienceSummary[],
  ): Promise<ProductGeneratedVariant[]> {
    const result = await this.tryGenerate(jdText, targetRole, experiences);
    const now = new Date().toISOString();
    return result.variants.map((variant) => {
      const scores: Record<string, number> = {
        overall: variant.score.overall,
        relevance: variant.score.relevance,
        evidenceStrength: variant.score.evidenceStrength,
      };
      if (variant.score.quantifiedImpact != null) scores.quantifiedImpact = variant.score.quantifiedImpact;
      if (variant.score.clarity != null) scores.clarity = variant.score.clarity;

      return {
        id: `pvar-${randomUUID()}`,
        userId,
        content: variant.content,
        reason: variant.reason,
        sourceExperienceIds: variant.sourceExperienceIds ?? [],
        sourceEvidenceIds: [],
        scores,
        evidenceSummary: variant.evidenceSummary,
        riskSummary: variant.riskSummary,
        missingInfo: variant.missingInfo,
        createdAt: now,
      };
    });
  }

  private async tryGenerate(
    jdText: string,
    targetRole: string | undefined,
    experiences: ProductExperienceSummary[],
  ): Promise<z.infer<typeof GenerationResultSchema>> {
    try {
      const response = await this.modelClient.chat({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(jdText, targetRole, experiences) },
        ],
        temperature: 0.4,
        maxTokens: 8192,
        responseFormat: "json",
      });

      const parsed = parseJson(response.content);
      const validated = GenerationResultSchema.safeParse(parsed);

      if (validated.success) return validated.data;

      return await this.repairGeneration(jdText, targetRole, experiences, validated.error.issues);
    } catch {
      return { variants: [] };
    }
  }

  private async repairGeneration(
    jdText: string,
    targetRole: string | undefined,
    experiences: ProductExperienceSummary[],
    issues: z.ZodIssue[],
  ): Promise<z.infer<typeof GenerationResultSchema>> {
    try {
      const errorSummary = issues
        .slice(0, 6)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("\n");

      const response = await this.modelClient.chat({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(jdText, targetRole, experiences) },
          { role: "assistant", content: "[previous output had schema errors]" },
          { role: "user", content: REPAIR_PROMPT.replace("{{errors}}", errorSummary) },
        ],
        temperature: 0.3,
        maxTokens: 8192,
        responseFormat: "json",
      });

      const parsed = parseJson(response.content);
      const validated = GenerationResultSchema.safeParse(parsed);

      if (validated.success) return validated.data;

      // Fallback: extract valid variants
      if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as Record<string, unknown>).variants)) {
        const validVariants: z.infer<typeof GeneratedVariantSchema>[] = [];
        for (const v of (parsed as Record<string, unknown>).variants as unknown[]) {
          const r = GeneratedVariantSchema.safeParse(v);
          if (r.success) validVariants.push(r.data);
        }
        if (validVariants.length > 0) return { variants: validVariants };
      }

      return { variants: [] };
    } catch {
      return { variants: [] };
    }
  }
}

function parseJson(content: string): unknown {
  const trimmed = content.trim();
  const jsonBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const json = jsonBlock?.[1] ?? trimmed;
  try {
    return JSON.parse(json);
  } catch {
    const braceStart = json.indexOf("{");
    const braceEnd = json.lastIndexOf("}");
    if (braceStart >= 0 && braceEnd > braceStart) {
      return JSON.parse(json.slice(braceStart, braceEnd + 1));
    }
    return {};
  }
}
