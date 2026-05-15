import { z } from "zod";
import { BaseAgent } from "../core/agent/BaseAgent.js";
import type { BaseAgentConfig } from "../core/agent/types.js";
import {
  FrontDeskDecisionParseError,
  buildFrontDeskRepairPrompt,
  buildFrontDeskSystemPrompt,
  parseFrontDeskDecision,
} from "./frontdesk/index.js";

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

export type FrontDeskAgentConfig = Omit<
  BaseAgentConfig,
  "name" | "role" | "systemPrompt" | "defaultResponseFormat"
> & {
  allowJsonRepair?: boolean;
  allowFallbackDecision?: boolean;
};

export class FrontDeskAgent extends BaseAgent {
  private readonly allowJsonRepair: boolean;
  private readonly allowFallbackDecision: boolean;

  public constructor(config: FrontDeskAgentConfig) {
    super({
      ...config,
      name: "frontdesk",
      role: "Product entry router",
      defaultResponseFormat: "json",
      systemPrompt: buildFrontDeskSystemPrompt(),
    });
    this.allowJsonRepair = config.allowJsonRepair ?? true;
    this.allowFallbackDecision = config.allowFallbackDecision ?? true;
  }

  public async decide(input: FrontDeskDecisionInput): Promise<FrontDeskDecision> {
    const content = this.toDecisionPrompt(input);
    const output = await this.run({
      content,
      responseFormat: "json",
      temperature: 0,
      maxTokens: 800,
    });

    try {
      return parseFrontDeskDecision(output.content);
    } catch (error) {
      if (!(error instanceof FrontDeskDecisionParseError)) {
        throw error;
      }
      return this.repairOrFallback(input, output.content, error);
    }
  }

  private async repairOrFallback(
    input: FrontDeskDecisionInput,
    raw: string,
    parseError: FrontDeskDecisionParseError,
  ): Promise<FrontDeskDecision> {
    if (this.allowJsonRepair) {
      const repairOutput = await this.run({
        content: buildFrontDeskRepairPrompt({
          invalidResponse: raw,
          parseError: parseError.reason,
        }),
        responseFormat: "json",
        temperature: 0,
        maxTokens: 800,
      });

      try {
        return parseFrontDeskDecision(repairOutput.content);
      } catch (repairError) {
        if (!this.allowFallbackDecision) {
          throw repairError;
        }
      }
    }

    if (this.allowFallbackDecision) {
      return this.createFallbackDecision(input);
    }

    throw parseError;
  }

  private createFallbackDecision(input: FrontDeskDecisionInput): FrontDeskDecision {
    return {
      intent: "unknown",
      confidence: 0,
      summary: "FrontDeskAgent could not parse model output.",
      requiredActions: [],
      followUpQuestion: input.hasDocument
        ? "Do you want me to import this document, generate resume content, or inspect evidence?"
        : "Do you want to import experience, generate resume content, or inspect evidence?",
    };
  }

  private toDecisionPrompt(input: FrontDeskDecisionInput): string {
    return [
      `User id: ${input.userId}`,
      `Has document: ${input.hasDocument ? "yes" : "no"}`,
      `Document file names: ${(input.documentFileNames ?? []).join(", ") || "(none)"}`,
      `User message: ${input.message}`,
    ].join("\n");
  }
}
