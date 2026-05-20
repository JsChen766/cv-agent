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
        totalTokens: request.messages.length + 1,
      },
      raw: { provider: this.name },
    };
  }

  public async *stream(request: LLMChatRequest): AsyncIterable<LLMStreamChunk> {
    const response = await this.chat(request);
    yield { contentDelta: response.content };
  }

  private mockToolCall(toolName: string): ToolCall {
    return {
      id: "mock-tool-call-1",
      type: "function",
      function: {
        name: toolName,
        arguments: JSON.stringify(toolName === "getCurrentTime" ? {} : { message: "mock tool input" }),
      },
    };
  }

  private mockJsonResponse(request: LLMChatRequest, userContent: string): unknown {
    const agentName = request.metadata?.agentName;
    if (agentName === "archivist") return this.mockArchivist(userContent);
    if (agentName === "strategist") return this.mockStrategist();
    if (agentName === "architect") return this.mockArtifactResponse(userContent);
    if (agentName === "frontdesk_agent_runtime") return this.mockAgentRuntimeDecision(userContent);
    if (agentName === "frontdesk") return this.mockFrontDeskResponse(userContent);
    return { provider: this.name, input: userContent, model: request.model };
  }

  private mockAgentRuntimeDecision(userContent: string): Record<string, unknown> {
    const payload = this.parseObject(userContent);
    const message = typeof payload.userMessage === "string" ? payload.userMessage : this.extractUserMessage(userContent);
    const lower = message.toLowerCase();
    const locale = payload.locale === "zh-CN" || this.hasCjk(message) ? "zh-CN" : "en";
    const hasJD = Boolean(this.readNested(payload, ["requestContext", "hasJDText"]));
    const hasResume = Boolean(this.readNested(payload, ["requestContext", "hasResumeText"]));
    const prompts = suggestedPrompts(locale);

    if (lower.includes("export") || lower.includes("download") || message.includes("导出") || message.includes("下載") || message.includes("下载")) {
      return this.agentDecision("call_tool", locale === "zh-CN" ? "我会为当前简历创建导出任务。" : "I'll create an export job for the current resume.", "export_resume");
    }

    if (lower.includes("resume history") || lower.includes("list resumes") || message.includes("历史简历") || message.includes("鍘嗗彶")) {
      return this.agentDecision("call_tool", locale === "zh-CN" ? "我来查看历史简历。" : "I'll open your resume history.", "list_resumes");
    }
    if (lower.includes("import resume") || lower.includes("here is my resume") || message.includes("导入") || message.includes("瀵煎叆")) {
      return this.agentDecision("call_tool", locale === "zh-CN" ? "我来导入这段简历文本。" : "I'll import this resume text.", "import_resume_text");
    }
    if (lower.includes("evidence") || message.includes("证据") || message.includes("璇佹嵁")) {
      return this.agentDecision("call_tool", locale === "zh-CN" ? "我来展开这个版本的证据。" : "I'll show the evidence for this version.", "show_evidence");
    }
    if (lower.includes("why") || lower.includes("recommend") || message.includes("为什么") || message.includes("推荐") || message.includes("涓轰粈涔堟帹鑽")) {
      return this.agentDecision("call_tool", locale === "zh-CN" ? "我来解释为什么推荐这个版本。" : "I'll explain why this version is recommended.", "explain_choice");
    }
    if (lower.includes("conservative") || message.includes("保守") || message.includes("淇濆畧")) {
      return this.agentDecision("call_tool", locale === "zh-CN" ? "我会生成一个更保守的版本。" : "I'll make a more conservative revision.", "revise_variant", { instruction: "make_more_conservative" });
    }
    if (lower.includes("accept") || lower.includes("use the first") || message.includes("就用") || message.includes("采用") || message.includes("灏辩敤")) {
      return this.agentDecision("call_tool", locale === "zh-CN" ? "我会采用当前推荐版本并保存到简历草稿。" : "I'll save the selected version to your resume draft.", "save_variant_to_resume");
    }
    if (lower.includes("save") && lower.includes("experience") || message.includes("保存") && message.includes("经历") || message.includes("淇濆瓨") && message.includes("缁忓巻")) {
      return this.agentDecision("call_tool", locale === "zh-CN" ? "我会把这段内容保存到经历库。" : "I'll save this to your experience library.", "create_experience", { content: message });
    }
    if (lower.includes("generate") || lower.includes("job description") || lower.includes("jd") || message.includes("生成") || message.includes("简历") || message.includes("鐢熸垚") || message.includes("绠€鍘")) {
      if (!hasJD) {
        return {
          mode: "ask_clarification",
          assistantMessage: locale === "zh-CN" ? "请先把 JD 发给我，我再帮你生成定制简历。" : "Please paste the JD first, then I can generate tailored resume variants.",
          missingInputs: ["jdText"],
          confidence: 0.8,
        };
      }
      return this.agentDecision("call_tool", locale === "zh-CN" ? "我会根据这个 JD 生成几个简历版本。" : "I'll generate tailored resume variants from this JD.", "generate_resume_variants");
    }
    if (lower.includes("experience library") || lower.includes("list experiences") || message.includes("经历库") || message.includes("缁忓巻搴")) {
      return this.agentDecision("call_tool", locale === "zh-CN" ? "我来查看你的经历库。" : "I'll open your experience library.", "list_experiences");
    }
    if (lower.includes("resume history") || lower.includes("list resumes") || message.includes("历史简历") || message.includes("鍘嗗彶绠")) {
      return this.agentDecision("call_tool", locale === "zh-CN" ? "我来查看历史简历。" : "I'll open your resume history.", "list_resumes");
    }
    if (lower.includes("import resume") || lower.includes("here is my resume") || message.includes("导入") || message.includes("瀵煎叆") || (hasResume && lower.includes("resume"))) {
      return this.agentDecision("call_tool", locale === "zh-CN" ? "我来导入这段简历文本。" : "I'll import this resume text.", "import_resume_text");
    }
    if (lower.includes("career advice") || lower.includes("how") && lower.includes("write") || message.includes("项目经历") || message.includes("椤圭洰缁忓巻")) {
      return {
        mode: "respond",
        assistantMessage: locale === "zh-CN"
          ? "项目经历建议先写清楚场景、动作、技术栈和结果，再补充可验证的证据或指标。"
          : "For project experience, start with context, your action, the stack, and the measurable result.",
        suggestedPrompts: prompts,
        confidence: 0.9,
      };
    }
    return {
      mode: "respond",
      assistantMessage: locale === "zh-CN"
        ? "我是 Coolto Copilot，可以帮你管理经历库、导入简历、保存 JD，并根据 JD 生成和修改定制简历。"
        : "I'm Coolto Copilot. I can help manage your experience library, import resumes, save JDs, and generate tailored resume variants.",
      suggestedPrompts: prompts,
      confidence: 0.9,
    };
  }

  private agentDecision(mode: string, assistantMessage: string, toolName: string, args: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      mode,
      assistantMessage,
      toolCalls: [{ toolName, arguments: args }],
      confidence: 0.9,
    };
  }

  private mockFrontDeskResponse(userContent: string): Record<string, unknown> {
    const hasDocument = /Has document:\s*yes/i.test(userContent);
    const message = this.extractUserMessage(userContent);
    if (hasDocument) {
      return {
        intent: "ingest_resume_document",
        confidence: 0.92,
        summary: "User attached a document to ingest.",
        requiredActions: [{ type: "load_document", target: "documentLoader" }],
      };
    }
    if (/\b(job description|jd|generate|resume for|target role)\b/i.test(message)) {
      return {
        intent: "generate_resume_for_jd",
        confidence: 0.86,
        summary: "User wants resume artifacts for a job description.",
        requiredActions: [{ type: "generate_resume", target: "ResumeGenerationService" }],
      };
    }
    if (/\b(evidence chain|explain evidence|why supported|supporting evidence)\b/i.test(message)) {
      return {
        intent: "explain_evidence_chain",
        confidence: 0.84,
        summary: "User wants to inspect evidence chain snapshots.",
        requiredActions: [{ type: "query_evidence_chain", target: "EvidenceChainQueryService" }],
      };
    }
    if (/\b(graph|experience graph|show graph|relationship map)\b/i.test(message)) {
      return {
        intent: "show_experience_graph",
        confidence: 0.84,
        summary: "User wants to inspect experience graph snapshots.",
        requiredActions: [{ type: "query_graph", target: "GraphViewQueryService" }],
      };
    }
    if (/\b(react|typescript|built|led|reduced|improved|worked|experience)\b/i.test(message)) {
      return {
        intent: "add_experience_text",
        confidence: 0.82,
        summary: "User provided experience text.",
        requiredActions: [{ type: "ingest_experience", target: "ExperienceIngestionService" }],
      };
    }
    return {
      intent: "ask_followup_question",
      confidence: 0.55,
      summary: "More information is needed.",
      requiredActions: [],
      followUpQuestion: "Do you want to import experience, generate resume content, or inspect evidence?",
    };
  }

  private mockArchivist(userContent: string): Record<string, unknown> {
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

  private mockStrategist(): Record<string, unknown> {
    return {
      requirements: [
        { description: "React and TypeScript frontend engineering experience", weight: 1 },
        { description: "Performance optimization and bundle size improvement experience", weight: 0.85 },
        { description: "Design system and accessible component library experience", weight: 0.8 },
      ],
    };
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

  private parseObject(text: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(text) as unknown;
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  private readNested(root: Record<string, unknown>, path: string[]): unknown {
    let current: unknown = root;
    for (const key of path) {
      if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  }

  private hasCjk(text: string): boolean {
    return /[\u3400-\u9fff]/u.test(text);
  }

  private extractRawText(userContent: string): string {
    const marker = "rawText:";
    const markerIndex = userContent.indexOf(marker);
    return markerIndex === -1 ? userContent.trim() : userContent.slice(markerIndex + marker.length).trim();
  }

  private extractUserMessage(userContent: string): string {
    const marker = "User message:";
    const markerIndex = userContent.indexOf(marker);
    return markerIndex === -1 ? userContent : userContent.slice(markerIndex + marker.length).trim();
  }

  private extractEvidenceExcerpts(rawText: string): string[] {
    return rawText
      .split(/\r?\n|(?<=[.!?])\s+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 5);
  }

  private detectExperienceType(rawText: string): string {
    if (/\b(school|university|student|degree|coursework)\b/i.test(rawText)) return "education";
    if (/\b(volunteer|nonprofit)\b/i.test(rawText)) return "volunteer";
    if (/\b(project|built|shipped|launched)\b/i.test(rawText)) {
      return /\b(at|corp|inc|company)\b/i.test(rawText) ? "work" : "project";
    }
    return "other";
  }

  private detectOrganization(rawText: string): string {
    return rawText.match(/\bat\s+([^,\n.]+)/i)?.[1]?.trim() || "Unknown Organization";
  }

  private detectRole(rawText: string): string {
    return rawText.match(/\bas\s+(?:a|an)\s+([^,\n.]+?)\s+at\s+/i)?.[1]?.trim() || "Contributor";
  }

  private summarize(rawText: string): string {
    const firstLine = this.extractEvidenceExcerpts(rawText)[0] ?? rawText.trim();
    return firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine;
  }

  private extractAll(text: string, pattern: RegExp): string[] {
    return Array.from(new Set(Array.from(text.matchAll(pattern)).map((match) => match[1])));
  }
}

function suggestedPrompts(locale: "zh-CN" | "en"): Array<{ label: string; message: string }> {
  if (locale === "zh-CN") {
    return [
      { label: "查看我的经历库", message: "查看我的经历库" },
      { label: "根据 JD 生成简历", message: "我想根据 JD 生成一份定制简历" },
      { label: "帮我保存一段经历", message: "帮我保存一段新的经历" },
      { label: "导入简历文本", message: "我想导入我的简历文本" },
      { label: "查看历史简历", message: "查看我的历史简历" },
    ];
  }
  return [
    { label: "Show my experience library.", message: "Show my experience library." },
    { label: "Generate from JD", message: "I want to generate a tailored resume from a JD." },
    { label: "Save an experience", message: "Help me save a new experience." },
    { label: "Import resume text", message: "I want to import my resume text." },
    { label: "Show resume history", message: "Show my resume history." },
  ];
}
