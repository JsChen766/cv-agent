import type { ModelClient } from "../../core/model/ModelClient.js";
import type {
  CopilotChatRequest,
  CopilotMessage,
  CopilotSession,
  CopilotWorkspace,
} from "../types.js";
import { ProductIntentRouter } from "../ProductIntentRouter.js";
import {
  type FrontDeskDecision,
  type FrontDeskMissingInput,
  parseFrontDeskDecision,
} from "./FrontDeskDecision.js";

export type ConversationalFrontDeskMode = "deterministic" | "llm";

export type ConversationalFrontDeskDecisionInput = {
  message: string;
  request: CopilotChatRequest;
  session: CopilotSession;
  workspace?: CopilotWorkspace;
  clientState?: CopilotChatRequest["clientState"];
  hasResume: boolean;
  hasJD: boolean;
  targetRole?: string | null;
  recentMessages: CopilotMessage[];
};

export type ConversationalFrontDeskAgentConfig = {
  mode?: ConversationalFrontDeskMode;
  modelClient?: ModelClient;
};

export class ConversationalFrontDeskAgent {
  private readonly mode: ConversationalFrontDeskMode;
  private readonly router = new ProductIntentRouter();

  public constructor(private readonly config: ConversationalFrontDeskAgentConfig = {}) {
    this.mode = config.mode ?? readFrontDeskConversationMode();
  }

  public async decide(input: ConversationalFrontDeskDecisionInput): Promise<FrontDeskDecision> {
    if (this.mode === "llm" && this.config.modelClient) {
      try {
        return await this.decideWithLLM(input);
      } catch {
        return this.decideDeterministically(input);
      }
    }
    return this.decideDeterministically(input);
  }

  public decideDeterministically(input: ConversationalFrontDeskDecisionInput): FrontDeskDecision {
    const message = input.message.trim();
    const lower = message.toLowerCase();
    const workspace = input.workspace;
    const activeVariantId = input.clientState?.activeVariantId ?? workspace?.activeVariantId ?? workspace?.variants[0]?.id;
    const hasVariants = Boolean(workspace?.variants.length);

    if (isProductCapabilityQuestion(message, lower)) {
      return chatOnly("ask_product_capability", capabilityDraft(), 0.92, [
        { type: "list_experiences", label: "View experience library" },
        { type: "generate_resume_for_jd", label: "Generate from JD" },
      ]);
    }

    if (isCareerAdviceQuestion(message, lower)) {
      return chatOnly("career_advice", careerAdviceDraft(), 0.88, [
        { type: "create_experience", label: "Save an experience" },
        { type: "generate_resume_for_jd", label: "Tailor resume to JD" },
      ]);
    }

    if (isSmalltalk(message, lower)) {
      return {
        mode: "smalltalk",
        intent: "general_chat",
        confidence: 0.82,
        assistantDraft: "Hi, I am Coolto Copilot. I can chat about your job search, help shape your experience stories, and use your workspace when you want to save experiences, import a resume, or generate tailored resume variants for a JD.",
        nextActions: [
          { type: "list_experiences", label: "View experience library" },
          { type: "generate_resume_for_jd", label: "Generate from JD" },
        ],
      };
    }

    if (hasVariants && isExplainChoiceRequest(message, lower)) {
      return {
        mode: "explain_workspace",
        intent: "explain_choice",
        confidence: 0.88,
        assistantDraft: "I can explain the recommendation based on the current variants, the JD signals, and the evidence attached to each version.",
        toolCall: activeVariantId ? { name: "open_resume", arguments: { variantId: activeVariantId } } : undefined,
        nextActions: activeVariantId ? [{ type: "show_evidence", label: "Show evidence" }] : undefined,
      };
    }

    if (hasVariants && isEvidenceRequest(message, lower)) {
      return {
        mode: "explain_workspace",
        intent: "show_evidence",
        confidence: 0.88,
        assistantDraft: "I can show the evidence that supports the current recommendation and call out where the draft may be stretching beyond the source material.",
        nextActions: activeVariantId ? [{ type: "show_evidence", label: "Show evidence" }] : undefined,
      };
    }

    if (hasVariants && isConservativeRevisionRequest(message, lower)) {
      return {
        mode: "explain_workspace",
        intent: "revise_variant",
        confidence: 0.88,
        assistantDraft: "Understood. A safer version should keep the claims closer to verified evidence, reduce inflated wording, and avoid metrics that are not backed by your source material.",
        nextActions: activeVariantId ? [{ type: "revise_more_conservative", label: "Make it more conservative" }] : undefined,
      };
    }

    if (hasVariants && isQuantifiedRevisionRequest(message, lower)) {
      return {
        mode: "explain_workspace",
        intent: "revise_variant",
        confidence: 0.88,
        assistantDraft: "I will make the current version more quantified while staying grounded in the evidence.",
        nextActions: activeVariantId ? [{ type: "revise_more_quantified", label: "Make it more quantified" }] : undefined,
      };
    }

    if (hasVariants && isAcceptVariantRequest(message, lower)) {
      if (!workspace?.productGenerationId || !activeVariantId) {
        return ask("accept_variant", "Which generated version should I save to your resume draft?", ["variantId"]);
      }
      return {
        mode: "use_product_tool",
        intent: "accept_variant",
        confidence: 0.88,
        assistantDraft: "I will save that version into your resume draft.",
        toolCall: {
          name: "save_variant_to_resume",
          arguments: {
            generationId: workspace.productGenerationId,
            variantId: activeVariantId,
            resumeId: workspace.resumeId,
          },
        },
      };
    }

    if (isListExperiencesRequest(message, lower)) {
      return tool("list_experiences", 0.95, "I will open your experience library.", {
        name: "list_experiences",
        arguments: {},
      });
    }

    if (isAddExperienceRequest(message, lower)) {
      const content = extractExperienceContent(message);
      if (!content || content.length < 8) {
        return ask("add_experience", "Send me the experience content you want to save, and I will add it to your experience library.", ["experienceContent"]);
      }
      return tool("add_experience", 0.9, "I will save this into your experience library.", {
        name: "create_experience",
        arguments: {
          ...parseExperience(content),
        },
      });
    }

    if (isImportResumeRequest(message, lower) || (input.request.resumeText && input.request.resumeText.length > 120 && !input.request.jdText)) {
      const resumeText = input.request.resumeText ?? extractResumeText(message);
      if (!resumeText?.trim()) {
        return ask("import_resume", "Paste the resume text you want me to import, and I will turn it into experience candidates.", ["resumeText"]);
      }
      return tool("import_resume", 0.86, "I will import the resume text and extract candidate experiences.", {
        name: "import_resume_text",
        arguments: { rawText: resumeText },
      });
    }

    if (isListJDsRequest(message, lower)) {
      return tool("list_jds", 0.86, "I will open your saved JD library.", {
        name: "list_jds",
        arguments: {},
      });
    }

    if (isSaveJDRequest(message, lower)) {
      const jdText = input.request.jdText ?? extractJDText(message);
      if (!jdText?.trim()) {
        return ask("save_jd", "Paste the JD text you want to save, and I will add it to your JD library.", ["jdText"]);
      }
      return tool("save_jd", 0.86, "I will save this JD to your library.", {
        name: "save_jd",
        arguments: { rawText: jdText, targetRole: input.targetRole ?? undefined },
      });
    }

    if (isListResumesRequest(message, lower)) {
      return tool("list_resumes", 0.88, "I will open your resume history.", {
        name: "list_resumes",
        arguments: {},
      });
    }

    if (isGenerateRequest(message, lower)) {
      if (!input.hasJD) {
        return ask("generate_resume_for_jd", "Please paste the JD first, then I can generate tailored resume variants for this application.", ["jdText"]);
      }
      return {
        mode: "generate_resume_variants",
        intent: "generate_resume_for_jd",
        confidence: 0.93,
        assistantDraft: "I will generate resume variants tailored to this JD.",
      };
    }

    const fallback = this.router.route(input.request);
    if (fallback.intent !== "unknown") {
      return fallbackDecision(fallback.intent, fallback.confidence, input);
    }

    return chatOnly("general_chat", "I can help with that. Tell me what role or application you are working on, or paste a rough experience and I can help turn it into a stronger resume story.", 0.58, [
      { type: "create_experience", label: "Save an experience" },
      { type: "generate_resume_for_jd", label: "Generate from JD" },
    ]);
  }

  private async decideWithLLM(input: ConversationalFrontDeskDecisionInput): Promise<FrontDeskDecision> {
    if (!this.config.modelClient) {
      return this.decideDeterministically(input);
    }
    const response = await this.config.modelClient.chat({
      responseFormat: "json",
      temperature: 0,
      maxTokens: 900,
      metadata: { agentName: "conversational_frontdesk" },
      messages: [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: buildDecisionPrompt(input) },
      ],
    });
    const parsed = JSON.parse(response.content) as unknown;
    return parseFrontDeskDecision(parsed);
  }
}

function readFrontDeskConversationMode(): ConversationalFrontDeskMode {
  return process.env.FRONTDESK_CONVERSATION_MODE === "llm" ? "llm" : "deterministic";
}

function chatOnly(
  intent: FrontDeskDecision["intent"],
  assistantDraft: string,
  confidence: number,
  nextActions?: FrontDeskDecision["nextActions"],
): FrontDeskDecision {
  return { mode: "chat_only", intent, confidence, assistantDraft, nextActions };
}

function tool(
  intent: FrontDeskDecision["intent"],
  confidence: number,
  assistantDraft: string,
  toolCall: NonNullable<FrontDeskDecision["toolCall"]>,
): FrontDeskDecision {
  return { mode: "use_product_tool", intent, confidence, assistantDraft, toolCall };
}

function ask(
  intent: FrontDeskDecision["intent"],
  assistantDraft: string,
  missingInputs: FrontDeskMissingInput[],
): FrontDeskDecision {
  return { mode: "ask_clarification", intent, confidence: 0.84, assistantDraft, missingInputs };
}

function fallbackDecision(
  intent: string,
  confidence: number,
  input: ConversationalFrontDeskDecisionInput,
): FrontDeskDecision {
  switch (intent) {
    case "list_experiences":
      return tool("list_experiences", confidence, "I will open your experience library.", { name: "list_experiences", arguments: {} });
    case "add_experience": {
      const content = extractExperienceContent(input.message);
      return content
        ? tool("add_experience", confidence, "I will save this into your experience library.", { name: "create_experience", arguments: parseExperience(content) })
        : ask("add_experience", "Send me the experience content you want to save.", ["experienceContent"]);
    }
    case "import_resume":
      return tool("import_resume", confidence, "I will import the resume text.", { name: "import_resume_text", arguments: { rawText: input.request.resumeText ?? input.message } });
    case "save_jd":
      return tool("save_jd", confidence, "I will save this JD.", { name: "save_jd", arguments: { rawText: input.request.jdText ?? extractJDText(input.message), targetRole: input.targetRole ?? undefined } });
    case "list_jds":
      return tool("list_jds", confidence, "I will open your saved JD library.", { name: "list_jds", arguments: {} });
    case "list_resumes":
      return tool("list_resumes", confidence, "I will open your resume history.", { name: "list_resumes", arguments: {} });
    case "generate_resume_for_jd":
      return input.hasJD
        ? { mode: "generate_resume_variants", intent: "generate_resume_for_jd", confidence, assistantDraft: "I will generate resume variants tailored to this JD." }
        : ask("generate_resume_for_jd", "Please paste the JD first, then I can generate tailored resume variants for this application.", ["jdText"]);
    default:
      return chatOnly("general_chat", "I can help with job search planning, resume writing, and your Coolto workspace. What would you like to work on first?", 0.45);
  }
}

function isSmalltalk(message: string, lower: string): boolean {
  const compact = lower.replace(/[!?.。！？,\s]/g, "");
  return ["hi", "hello", "hey", "你好", "您好"].includes(compact) || /^(hi|hello|hey)[\s!.]*$/i.test(message);
}

function isProductCapabilityQuestion(message: string, lower: string): boolean {
  return containsAny(message, ["你能做什么", "你可以做什么", "这个产品是干嘛", "怎么使用", "如何使用"]) ||
    /\b(what can you do|how do i use|how to use|what is this product)\b/i.test(lower);
}

function isCareerAdviceQuestion(message: string, lower: string): boolean {
  return containsAny(message, ["不知道怎么写", "怎么写项目经历", "怎么准备投递", "求职建议", "简历建议", "帮我吗"]) ||
    /\b(career advice|resume advice|write my experience|prepare applications|job search advice)\b/i.test(lower);
}

function isListExperiencesRequest(message: string, lower: string): boolean {
  return containsAny(message, ["查看我的经历库", "打开经历库", "我的经历", "经历列表"]) ||
    /\b(list|show|view).*(experience|experiences)\b/i.test(lower);
}

function isAddExperienceRequest(message: string, lower: string): boolean {
  return containsAny(message, ["保存这段经历", "加入经历库", "添加经历", "保存到经历库"]) ||
    /\b(save|add).*(experience|project)\b/i.test(lower);
}

function isImportResumeRequest(message: string, lower: string): boolean {
  return containsAny(message, ["导入简历", "这是我的简历"]) ||
    /\b(import|upload|parse).*(resume|cv)\b/i.test(lower) ||
    /\b(here is|this is).*(my )?(resume|cv)\b/i.test(lower);
}

function isSaveJDRequest(message: string, lower: string): boolean {
  return containsAny(message, ["保存JD", "保存 JD", "保存这个JD", "保存这个 JD", "这是JD", "这是 JD"]) ||
    /\b(save).*(jd|job description)\b/i.test(lower);
}

function isListJDsRequest(message: string, lower: string): boolean {
  return containsAny(message, ["查看 JD", "JD 列表", "历史 JD", "查看JD"]) ||
    /\b(list|show|view).*(jd|job descriptions)\b/i.test(lower);
}

function isListResumesRequest(message: string, lower: string): boolean {
  return containsAny(message, ["历史简历", "简历列表", "查看简历草稿"]) ||
    /\b(list|show|view).*(resume|resumes|drafts)\b/i.test(lower);
}

function isGenerateRequest(message: string, lower: string): boolean {
  return containsAny(message, ["生成简历", "投递简历", "根据这个 JD", "根据 JD", "根据这个JD", "改写简历"]) ||
    /\b(generate|tailor|create).*(resume|cv)\b/i.test(lower);
}

function isAcceptVariantRequest(message: string, lower: string): boolean {
  return containsAny(message, ["就用第一个", "采用推荐版本", "保存这个版本", "采用这个版本", "用这个版本"]) ||
    /\b(use|accept|save).*(first|recommended|this version|variant)\b/i.test(lower);
}

function isConservativeRevisionRequest(message: string, lower: string): boolean {
  return containsAny(message, ["太夸张", "保守一点", "低调一点", "别太夸张"]) ||
    /\b(too exaggerated|more conservative|tone it down|less aggressive)\b/i.test(lower);
}

function isQuantifiedRevisionRequest(message: string, lower: string): boolean {
  return containsAny(message, ["再量化一点", "更量化", "量化一点"]) ||
    /\b(more quantified|quantify|add metrics|more metrics|add numbers)\b/i.test(lower);
}

function isExplainChoiceRequest(message: string, lower: string): boolean {
  return containsAny(message, ["为什么推荐", "为什么是第一个", "解释推荐", "为什么选"]) ||
    /\b(why.*recommend|explain.*choice|why.*first)\b/i.test(lower);
}

function isEvidenceRequest(message: string, lower: string): boolean {
  return containsAny(message, ["证据呢", "有什么证据", "查看证据", "依据是什么"]) ||
    /\b(show|what).*(evidence|proof|support)\b/i.test(lower);
}

function containsAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => value.includes(pattern));
}

function extractExperienceContent(message: string): string {
  return stripLead(message, [
    "保存这段经历到经历库",
    "保存这段经历",
    "加入经历库",
    "添加经历到经历库",
    "添加经历",
    "save this experience",
    "add experience",
  ]);
}

function extractResumeText(message: string): string {
  return stripLead(message, ["导入简历", "这是我的简历", "import resume"]);
}

function extractJDText(message: string): string | undefined {
  const content = stripLead(message, ["保存这个 JD", "保存这个JD", "保存 JD", "保存JD", "这是 JD", "这是JD", "save jd"]);
  return content.length >= 20 ? content : undefined;
}

function stripLead(message: string, leads: string[]): string {
  let content = message.trim();
  for (const lead of leads) {
    if (content.toLowerCase().startsWith(lead.toLowerCase())) {
      content = content.slice(lead.length);
      break;
    }
  }
  return content.replace(/^[:：,\s]+/, "").trim();
}

function parseExperience(content: string): { title: string; category: string; content: string } {
  return {
    title: content.split(/\r?\n/)[0]?.slice(0, 80) || "New experience",
    category: /\b(project|built|shipped|launched)\b/i.test(content) || content.includes("项目") ? "project" : "work",
    content,
  };
}

function capabilityDraft(): string {
  return "I am Coolto Copilot, a job-search and resume workspace assistant. You can talk to me naturally, and when you ask for workspace actions I can help organize experiences, import resume text, save JDs, generate JD-tailored resume variants, explain evidence and risks, save an accepted version into a resume draft, and open your resume history.";
}

function careerAdviceDraft(): string {
  return "Yes. A good project experience usually needs four parts: what problem you owned, what actions you took, what technical choices mattered, and what measurable result changed. Send me a rough paragraph, even if it is messy, and I can help you shape it into a stronger resume story before saving it.";
}

function buildSystemPrompt(): string {
  return [
    "You are Coolto Copilot's front desk job-search assistant.",
    "Behave like a natural chat assistant. Product operations are only one capability.",
    "Return only valid JSON matching the FrontDeskDecision schema.",
    "Use chat_only for normal chat, product questions, confusion, and career advice.",
    "Use ask_clarification when a product operation is requested but required input is missing.",
    "Use use_product_tool or generate_resume_variants only when the user clearly asks for a workspace operation.",
    "Never expose tool names, internal intents, provider raw data, reasoning_content, or chain-of-thought in assistantDraft.",
    "Few-shot decisions:",
    JSON.stringify({ message: "你好，你能做什么？", output: { mode: "chat_only", intent: "ask_product_capability" } }),
    JSON.stringify({ message: "我不知道怎么写项目经历", output: { mode: "chat_only", intent: "career_advice" } }),
    JSON.stringify({ message: "查看我的经历库", output: { mode: "use_product_tool", intent: "list_experiences", toolCall: { name: "list_experiences", arguments: {} } } }),
    JSON.stringify({ message: "保存这段经历到经历库：Built React systems...", output: { mode: "use_product_tool", intent: "add_experience", toolCall: { name: "create_experience", arguments: { content: "Built React systems..." } } } }),
    JSON.stringify({ message: "根据这个 JD 生成简历", hasJD: true, output: { mode: "generate_resume_variants", intent: "generate_resume_for_jd" } }),
    JSON.stringify({ message: "帮我生成简历", hasJD: false, output: { mode: "ask_clarification", intent: "generate_resume_for_jd", missingInputs: ["jdText"] } }),
    JSON.stringify({ message: "这个太夸张了，保守一点", workspace: { hasVariants: true }, output: { mode: "explain_workspace", intent: "revise_variant", nextActions: [{ type: "revise_more_conservative", label: "Make it more conservative" }] } }),
    JSON.stringify({ message: "就用第一个", workspace: { hasVariants: true }, output: { mode: "use_product_tool", intent: "accept_variant", toolCall: { name: "save_variant_to_resume", arguments: { variantId: "active-or-first-variant" } } } }),
  ].join("\n");
}

function buildDecisionPrompt(input: ConversationalFrontDeskDecisionInput): string {
  const recentMessages = input.recentMessages.slice(-6).map((message) => ({
    role: message.role,
    content: message.content,
  }));
  return JSON.stringify({
    message: input.message,
    hasResume: input.hasResume,
    hasJD: input.hasJD,
    targetRole: input.targetRole,
    clientState: input.clientState ?? {},
    workspace: {
      hasVariants: Boolean(input.workspace?.variants.length),
      activeVariantId: input.clientState?.activeVariantId ?? input.workspace?.activeVariantId ?? input.workspace?.variants[0]?.id,
      productGenerationId: input.workspace?.productGenerationId,
      resumeId: input.workspace?.resumeId,
    },
    recentMessages,
  });
}
