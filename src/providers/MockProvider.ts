import type { LLMProvider } from "../core/model/LLMProvider.js";
import type { LLMChatRequest, LLMChatResponse, LLMStreamChunk } from "../core/model/types.js";
import type { ToolCall } from "../core/tool/types.js";

export class MockProvider implements LLMProvider {
  public readonly name = "mock";

  public async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    const lastUserMessage = [...request.messages].reverse().find((message) => message.role === "user");
    const toolCalls = request.tools?.length ? [this.mockToolCall(request.tools[0].function.name)] : undefined;

    return {
      content: request.responseFormat === "json"
        ? JSON.stringify(this.mockJsonResponse(request, lastUserMessage?.content ?? ""))
        : `[mock:${request.model}] ${lastUserMessage?.content ?? ""}`,
      reasoning: request.thinking ? "Mock reasoning trace." : undefined,
      toolCalls,
      usage: {
        promptTokens: request.messages.length,
        completionTokens: 1,
        totalTokens: request.messages.length + 1
      },
      raw: {
        provider: this.name,
        request
      }
    };
  }

  public async *stream(request: LLMChatRequest): AsyncIterable<LLMStreamChunk> {
    const response = await this.chat(request);
    yield {
      contentDelta: response.content,
      reasoningDelta: response.reasoning,
      raw: response.raw
    };
  }

  private mockToolCall(toolName: string): ToolCall {
    const args = toolName === "getCurrentTime" ? {} : { message: "mock tool input" };
    return {
      id: "mock-tool-call-1",
      type: "function",
      function: {
        name: toolName,
        arguments: JSON.stringify(args)
      }
    };
  }

  private mockJsonResponse(request: LLMChatRequest, userContent: string): unknown {
    const agentName = request.metadata?.agentName;

    if (agentName === "archivist") {
      const rawText = this.extractRawText(userContent);
      const excerpts = this.extractEvidenceExcerpts(rawText);

      return {
        type: this.detectExperienceType(rawText),
        organization: this.detectOrganization(rawText),
        role: this.detectRole(rawText),
        summary: this.summarize(rawText),
        evidenceExcerpts: excerpts.length > 0 ? excerpts : [rawText || "No source text provided."],
      };
    }

    if (agentName === "strategist") {
      return {
        requirements: [
          { description: "React and TypeScript frontend engineering experience", weight: 1 },
          { description: "Performance optimization and bundle size improvement experience", weight: 0.85 },
          { description: "Design system and accessible component library experience", weight: 0.8 },
        ],
      };
    }

    if (agentName === "architect") {
      return this.mockArtifactResponse(userContent);
    }

    return { provider: this.name, input: userContent, model: request.model };
  }

  private mockArtifactResponse(userContent: string): Array<Record<string, unknown>> {
    const sourceExperienceIds = this.extractAll(userContent, /Experience: ([^ |]+)/g);
    const sourceEvidenceIds = this.extractAll(userContent, /(exp-[a-z0-9]+-ev-\d+):/g);
    const matchedSkillIds = this.extractAll(userContent, /\b(skill-[a-z0-9]+)\b/g);
    const targetRequirementIds = this.extractAll(userContent, /\b(req-[a-z0-9]+)\b/g);
    const experienceIds = sourceExperienceIds.slice(0, 1);

    return [
      {
        type: "resume_bullet",
        content: "Led React and TypeScript frontend work grounded in design system evidence.",
        sourceExperienceIds: experienceIds,
        sourceEvidenceIds,
        matchedSkillIds,
        targetRequirementIds,
      },
      {
        type: "resume_bullet",
        content: "Improved product impact through performance optimization and accessible components.",
        sourceExperienceIds: experienceIds,
        sourceEvidenceIds,
        matchedSkillIds,
        targetRequirementIds,
      },
      {
        type: "resume_summary",
        content: "Frontend engineer with React, TypeScript, design system, accessibility, and performance experience.",
        sourceExperienceIds: experienceIds,
        sourceEvidenceIds,
        matchedSkillIds,
        targetRequirementIds,
      },
    ];
  }

  private extractRawText(userContent: string): string {
    const marker = "rawText:";
    const markerIndex = userContent.indexOf(marker);
    if (markerIndex === -1) {
      return userContent.trim();
    }
    return userContent.slice(markerIndex + marker.length).trim();
  }

  private extractEvidenceExcerpts(rawText: string): string[] {
    const lines = rawText
      .split(/\r?\n|(?<=[.!?])\s+/)
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.slice(0, 5);
  }

  private detectExperienceType(rawText: string): string {
    if (/\b(school|university|student|degree|coursework)\b/i.test(rawText)) {
      return "education";
    }
    if (/\b(volunteer|nonprofit)\b/i.test(rawText)) {
      return "volunteer";
    }
    if (/\b(project|built|shipped|launched)\b/i.test(rawText)) {
      return /\b(at|corp|inc|company)\b/i.test(rawText) ? "work" : "project";
    }
    return "other";
  }

  private detectOrganization(rawText: string): string {
    const match = rawText.match(/\bat\s+([^,\n.]+)/i);
    return match?.[1]?.trim() || "Unknown Organization";
  }

  private detectRole(rawText: string): string {
    const match = rawText.match(/\bas\s+(?:a|an)\s+([^,\n.]+?)\s+at\s+/i);
    return match?.[1]?.trim() || "Contributor";
  }

  private summarize(rawText: string): string {
    const firstLine = this.extractEvidenceExcerpts(rawText)[0] ?? rawText.trim();
    return firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine;
  }

  private extractAll(text: string, pattern: RegExp): string[] {
    return Array.from(new Set(Array.from(text.matchAll(pattern)).map((match) => match[1])));
  }
}
