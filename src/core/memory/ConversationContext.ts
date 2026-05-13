import type { LLMMessage } from "../model/types.js";
import type { ConversationContextInput } from "./types.js";

export class ConversationContext {
  private readonly input: ConversationContextInput;

  public constructor(input: ConversationContextInput = {}) {
    this.input = input;
  }

  public buildMessages(systemPrompt: string, userInput: string): LLMMessage[] {
    const contextParts: string[] = [];

    if (this.input.userProfile) {
      contextParts.push(`User profile:\n${JSON.stringify(this.input.userProfile, null, 2)}`);
    }

    if (this.input.retrievedKnowledge?.length) {
      contextParts.push(`Retrieved knowledge:\n${this.input.retrievedKnowledge.join("\n\n")}`);
    }

    if (this.input.taskMetadata) {
      contextParts.push(`Task metadata:\n${JSON.stringify(this.input.taskMetadata, null, 2)}`);
    }

    const contextMessage: LLMMessage[] = contextParts.length
      ? [{ role: "user", content: `Context for this task:\n\n${contextParts.join("\n\n")}` }]
      : [];

    return [
      { role: "system", content: systemPrompt },
      ...(this.input.shortTermMemory ?? []),
      ...contextMessage,
      { role: "user", content: userInput }
    ];
  }
}
