import { z } from "zod";
import { BaseAgent } from "../core/agent/BaseAgent.js";
import type { BaseAgentConfig } from "../core/agent/types.js";
import { parseAgentJson } from "../core/json/index.js";
import { parseWithSchema } from "../knowledge/schemas/validate.js";

export const FrontDeskIntentSchema = z.enum([
  "ingest_resume_document",
  "add_experience_text",
  "generate_resume_for_jd",
  "revise_generated_artifact",
  "explain_evidence_chain",
  "show_experience_graph",
  "ask_followup_question",
  "unknown",
]);

export type FrontDeskIntent = z.infer<typeof FrontDeskIntentSchema>;

export const FrontDeskActionSchema = z.object({
  type: z.string(),
  target: z.string().optional(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

export const FrontDeskDecisionSchema = z.object({
  intent: FrontDeskIntentSchema,
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  requiredActions: z.array(FrontDeskActionSchema),
  followUpQuestion: z.string().optional(),
});

export type FrontDeskDecision = z.infer<typeof FrontDeskDecisionSchema>;

export type FrontDeskDecisionInput = {
  userId: string;
  message: string;
  hasDocument?: boolean;
  documentFileNames?: string[];
};

export class FrontDeskAgent extends BaseAgent {
  public constructor(config: Omit<BaseAgentConfig, "name" | "role" | "systemPrompt" | "defaultResponseFormat">) {
    super({
      ...config,
      name: "frontdesk",
      role: "Product entry router",
      defaultResponseFormat: "json",
      systemPrompt: [
        "You are Coolto's FrontDeskAgent.",
        "Your job is to classify the user's product intent and output routing JSON only.",
        "Do not execute business logic.",
        "Do not generate resume artifacts yourself.",
        "Do not ingest experience yourself.",
        "",
        "Allowed intent values:",
        "ingest_resume_document",
        "add_experience_text",
        "generate_resume_for_jd",
        "revise_generated_artifact",
        "explain_evidence_chain",
        "show_experience_graph",
        "ask_followup_question",
        "unknown",
        "",
        "Output exactly this JSON shape:",
        "{",
        '  "intent": "add_experience_text",',
        '  "confidence": 0.8,',
        '  "summary": "string",',
        '  "requiredActions": [{ "type": "string", "target": "string", "arguments": {} }],',
        '  "followUpQuestion": "string"',
        "}",
        "",
        "Use ingest_resume_document when a document is attached.",
        "Use add_experience_text when the user provides resume or experience text directly.",
        "Use generate_resume_for_jd when the user provides a job description or asks to generate resume bullets for a role.",
        "Use ask_followup_question when required information is missing.",
        "Return the JSON object only.",
      ].join("\n"),
    });
  }

  public async decide(input: FrontDeskDecisionInput): Promise<FrontDeskDecision> {
    const output = await this.run({
      content: [
        `User id: ${input.userId}`,
        `Has document: ${input.hasDocument ? "yes" : "no"}`,
        `Document file names: ${(input.documentFileNames ?? []).join(", ") || "(none)"}`,
        `User message: ${input.message}`,
      ].join("\n"),
      responseFormat: "json",
    });

    const parsed = parseAgentJson(output.content, { expectedRoot: "object" });
    return parseWithSchema(FrontDeskDecisionSchema, parsed, "FrontDeskAgent");
  }
}
