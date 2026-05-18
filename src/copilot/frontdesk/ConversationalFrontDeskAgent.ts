import type { ModelClient } from "../../core/model/ModelClient.js";
import type {
  CopilotChatRequest,
  CopilotMessage,
  CopilotSession,
  CopilotWorkspace,
} from "../types.js";
import { detectLocale, type CopilotLocale } from "../locale.js";
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
      } catch (error) {
        console.warn("FrontDeskAgent JSON decision failed", {
          agentName: "conversational_frontdesk",
          sessionId: input.session.id,
          error: error instanceof Error ? error.message : "unknown error",
        });
        return this.decideDeterministically(input);
      }
    }
    return this.decideDeterministically(input);
  }

  public decideDeterministically(input: ConversationalFrontDeskDecisionInput): FrontDeskDecision {
    const message = input.message.trim();
    const lower = message.toLowerCase();
    const locale = detectLocale(message, input.clientState);
    const workspace = input.workspace;
    const activeVariantId = input.clientState?.activeVariantId ?? workspace?.activeVariantId ?? workspace?.variants[0]?.id;
    const hasVariants = Boolean(workspace?.variants.length);

    if (isProductCapabilityQuestion(message, lower)) {
      return chatOnly("ask_product_capability", capabilityDraft(locale), 0.92, [
        action("list_experiences", locale, "查看经历库", "View experience library"),
        action("generate_resume_for_jd", locale, "根据 JD 生成简历", "Generate from JD"),
      ]);
    }

    if (isCareerAdviceQuestion(message, lower)) {
      return chatOnly("career_advice", careerAdviceDraft(locale), 0.88, [
        action("create_experience", locale, "保存经历", "Save an experience"),
        action("generate_resume_for_jd", locale, "根据 JD 优化简历", "Tailor resume to JD"),
      ]);
    }

    if (isSmalltalk(message, lower)) {
      return {
        mode: "smalltalk",
        intent: "general_chat",
        confidence: 0.82,
        assistantDraft: locale === "zh-CN"
          ? "你好，我是 Coolto Copilot。你可以和我聊求职方向、整理经历故事，也可以让我帮你保存经历、导入简历、保存 JD，或根据 JD 生成定制简历版本。"
          : "Hi, I am Coolto Copilot. I can chat about your job search, help shape your experience stories, and use your workspace when you want to save experiences, import a resume, or generate tailored resume variants for a JD.",
        nextActions: [
          action("list_experiences", locale, "查看经历库", "View experience library"),
          action("generate_resume_for_jd", locale, "根据 JD 生成简历", "Generate from JD"),
        ],
      };
    }

    if (hasVariants && isExplainChoiceRequest(message, lower)) {
      return {
        mode: "explain_workspace",
        intent: "explain_choice",
        confidence: 0.88,
        assistantDraft: locale === "zh-CN"
          ? "我可以根据当前版本、JD 信号和每个版本绑定的证据解释为什么推荐它。"
          : "I can explain the recommendation based on the current variants, the JD signals, and the evidence attached to each version.",
        nextActions: activeVariantId ? [action("show_evidence", locale, "查看证据", "Show evidence")] : undefined,
      };
    }

    if (hasVariants && isEvidenceRequest(message, lower)) {
      return {
        mode: "explain_workspace",
        intent: "show_evidence",
        confidence: 0.88,
        assistantDraft: locale === "zh-CN"
          ? "我会展示当前推荐所依据的证据，并指出哪些表述可能超出原始材料。"
          : "I can show the evidence that supports the current recommendation and call out where the draft may be stretching beyond the source material.",
        nextActions: activeVariantId ? [action("show_evidence", locale, "查看证据", "Show evidence")] : undefined,
      };
    }

    if (hasVariants && isConservativeRevisionRequest(message, lower)) {
      return {
        mode: "explain_workspace",
        intent: "revise_variant",
        confidence: 0.88,
        assistantDraft: locale === "zh-CN"
          ? "明白。更保守的版本会让表述更贴近已验证证据，减少夸张措辞，并避免没有来源支撑的数据。"
          : "Understood. A safer version should keep the claims closer to verified evidence, reduce inflated wording, and avoid metrics that are not backed by your source material.",
        nextActions: activeVariantId ? [action("revise_more_conservative", locale, "保守一点", "Make it more conservative")] : undefined,
      };
    }

    if (hasVariants && isQuantifiedRevisionRequest(message, lower)) {
      return {
        mode: "explain_workspace",
        intent: "revise_variant",
        confidence: 0.88,
        assistantDraft: locale === "zh-CN" ? "我会在证据允许的范围内，把当前版本改得更量化。" : "I will make the current version more quantified while staying grounded in the evidence.",
        nextActions: activeVariantId ? [action("revise_more_quantified", locale, "更量化", "Make it more quantified")] : undefined,
      };
    }

    if (hasVariants && isAcceptVariantRequest(message, lower)) {
      if (!workspace?.productGenerationId || !activeVariantId) {
        return ask("accept_variant", locale === "zh-CN" ? "你想保存哪个生成版本到简历草稿？" : "Which generated version should I save to your resume draft?", ["variantId"]);
      }
      return {
        mode: "use_product_tool",
        intent: "accept_variant",
        confidence: 0.88,
        assistantDraft: locale === "zh-CN" ? "我会把这个版本保存到你的简历草稿。" : "I will save that version into your resume draft.",
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
      return tool("list_experiences", 0.95, locale === "zh-CN" ? "我会打开你的经历库。" : "I will open your experience library.", { name: "list_experiences", arguments: {} });
    }

    if (isAddExperienceRequest(message, lower)) {
      const content = extractExperienceContent(message);
      if (!content || content.length < 8) {
        return ask("add_experience", locale === "zh-CN" ? "把你想保存的经历内容发给我，我会加入经历库。" : "Send me the experience content you want to save, and I will add it to your experience library.", ["experienceContent"]);
      }
      return tool("add_experience", 0.9, locale === "zh-CN" ? "我会把这段内容保存到经历库。" : "I will save this into your experience library.", { name: "create_experience", arguments: parseExperience(content) });
    }

    if (isImportResumeRequest(message, lower) || (input.request.resumeText && input.request.resumeText.length > 120 && !input.request.jdText)) {
      const resumeText = input.request.resumeText ?? extractResumeText(message);
      if (!resumeText?.trim()) {
        return ask("import_resume", locale === "zh-CN" ? "请粘贴要导入的简历文本，我会整理成候选经历。" : "Paste the resume text you want me to import, and I will turn it into experience candidates.", ["resumeText"]);
      }
      return tool("import_resume", 0.86, locale === "zh-CN" ? "我会导入简历文本并提取候选经历。" : "I will import the resume text and extract candidate experiences.", { name: "import_resume_text", arguments: { rawText: resumeText } });
    }

    if (isListJDsRequest(message, lower)) {
      return tool("list_jds", 0.86, locale === "zh-CN" ? "我会打开你的 JD 记录。" : "I will open your saved JD library.", { name: "list_jds", arguments: {} });
    }

    if (isSaveJDRequest(message, lower)) {
      const jdText = input.request.jdText ?? extractJDText(message);
      if (!jdText?.trim()) {
        return ask("save_jd", locale === "zh-CN" ? "请粘贴要保存的 JD 文本，我会加入 JD 记录。" : "Paste the JD text you want to save, and I will add it to your JD library.", ["jdText"]);
      }
      return tool("save_jd", 0.86, locale === "zh-CN" ? "我会保存这份 JD。" : "I will save this JD to your library.", {
        name: "save_jd",
        arguments: { rawText: jdText, targetRole: input.targetRole ?? undefined },
      });
    }

    if (isListResumesRequest(message, lower)) {
      return tool("list_resumes", 0.88, locale === "zh-CN" ? "我会打开你的历史简历。" : "I will open your resume history.", { name: "list_resumes", arguments: {} });
    }

    if (isGenerateRequest(message, lower)) {
      if (!input.hasJD) {
        return ask("generate_resume_for_jd", locale === "zh-CN" ? "请先粘贴 JD，然后我可以为这次投递生成定制简历版本。" : "Please paste the JD first, then I can generate tailored resume variants for this application.", ["jdText"]);
      }
      return {
        mode: "generate_resume_variants",
        intent: "generate_resume_for_jd",
        confidence: 0.93,
        assistantDraft: locale === "zh-CN" ? "我会根据这份 JD 生成定制简历版本。" : "I will generate resume variants tailored to this JD.",
      };
    }

    const fallback = this.router.route(input.request);
    if (fallback.intent !== "unknown") {
      return fallbackDecision(fallback.intent, fallback.confidence, input, locale);
    }

    return chatOnly("general_chat", locale === "zh-CN"
      ? "可以。告诉我你正在投递的岗位，或粘贴一段粗略经历，我可以帮你整理成更适合简历的表达。"
      : "I can help with that. Tell me what role or application you are working on, or paste a rough experience and I can help turn it into a stronger resume story.", 0.58, [
        action("create_experience", locale, "保存经历", "Save an experience"),
        action("generate_resume_for_jd", locale, "根据 JD 生成简历", "Generate from JD"),
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

function action(type: string, locale: CopilotLocale, zhLabel: string, enLabel: string): { type: string; label: string } {
  return { type, label: locale === "zh-CN" ? zhLabel : enLabel };
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
  locale: CopilotLocale,
): FrontDeskDecision {
  switch (intent) {
    case "list_experiences":
      return tool("list_experiences", confidence, locale === "zh-CN" ? "我会打开你的经历库。" : "I will open your experience library.", { name: "list_experiences", arguments: {} });
    case "add_experience": {
      const content = extractExperienceContent(input.message);
      return content
        ? tool("add_experience", confidence, locale === "zh-CN" ? "我会把这段内容保存到经历库。" : "I will save this into your experience library.", { name: "create_experience", arguments: parseExperience(content) })
        : ask("add_experience", locale === "zh-CN" ? "把你想保存的经历内容发给我。" : "Send me the experience content you want to save.", ["experienceContent"]);
    }
    case "import_resume":
      return tool("import_resume", confidence, locale === "zh-CN" ? "我会导入这份简历文本。" : "I will import the resume text.", { name: "import_resume_text", arguments: { rawText: input.request.resumeText ?? input.message } });
    case "save_jd":
      return tool("save_jd", confidence, locale === "zh-CN" ? "我会保存这份 JD。" : "I will save this JD.", { name: "save_jd", arguments: { rawText: input.request.jdText ?? extractJDText(input.message), targetRole: input.targetRole ?? undefined } });
    case "list_jds":
      return tool("list_jds", confidence, locale === "zh-CN" ? "我会打开你的 JD 记录。" : "I will open your saved JD library.", { name: "list_jds", arguments: {} });
    case "list_resumes":
      return tool("list_resumes", confidence, locale === "zh-CN" ? "我会打开你的历史简历。" : "I will open your resume history.", { name: "list_resumes", arguments: {} });
    case "generate_resume_for_jd":
      return input.hasJD
        ? { mode: "generate_resume_variants", intent: "generate_resume_for_jd", confidence, assistantDraft: locale === "zh-CN" ? "我会根据这份 JD 生成定制简历版本。" : "I will generate resume variants tailored to this JD." }
        : ask("generate_resume_for_jd", locale === "zh-CN" ? "请先粘贴 JD，然后我可以生成定制简历版本。" : "Please paste the JD first, then I can generate tailored resume variants for this application.", ["jdText"]);
    default:
      return chatOnly("general_chat", locale === "zh-CN" ? "我可以帮你处理求职规划、简历写作和 Coolto 工作台。" : "I can help with job search planning, resume writing, and your Coolto workspace. What would you like to work on first?", 0.45);
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
  return containsAny(message, ["不知道怎么写", "怎么写项目经历", "怎么准备投递", "求职建议", "简历建议", "帮我看"]) ||
    /\b(career advice|resume advice|write my experience|prepare applications|job search advice)\b/i.test(lower);
}

function isListExperiencesRequest(message: string, lower: string): boolean {
  return containsAny(message, ["查看我的经历库", "打开经历库", "我的经历", "经历列表"]) ||
    /\b(list|show|view).*(experience|experiences)\b/i.test(lower);
}

function isAddExperienceRequest(message: string, lower: string): boolean {
  return containsAny(message, ["保存这段经历", "加入经历库", "添加经历", "保存到经历库", "帮我保存一段经历"]) ||
    /\b(save|add).*(experience|project)\b/i.test(lower);
}

function isImportResumeRequest(message: string, lower: string): boolean {
  return containsAny(message, ["导入简历", "这是我的简历", "导入简历文本"]) ||
    /\b(import|upload|parse).*(resume|cv)\b/i.test(lower) ||
    /\b(here is|this is).*(my )?(resume|cv)\b/i.test(lower);
}

function isSaveJDRequest(message: string, lower: string): boolean {
  return containsAny(message, ["保存JD", "保存 JD", "保存这个JD", "保存这个 JD", "这是JD", "这是 JD"]) ||
    /\b(save).*(jd|job description)\b/i.test(lower);
}

function isListJDsRequest(message: string, lower: string): boolean {
  return containsAny(message, ["查看 JD", "JD 列表", "历史 JD", "查看JD", "JD 记录"]) ||
    /\b(list|show|view).*(jd|job descriptions)\b/i.test(lower);
}

function isListResumesRequest(message: string, lower: string): boolean {
  return containsAny(message, ["历史简历", "简历列表", "查看简历草稿", "查看历史简历"]) ||
    /\b(list|show|view).*(resume|resumes|drafts)\b/i.test(lower);
}

function isGenerateRequest(message: string, lower: string): boolean {
  return containsAny(message, ["生成简历", "投递简历", "根据这个 JD", "根据 JD", "根据这个JD", "改写简历", "根据 JD 生成简历"]) ||
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
  return stripLead(message, ["保存这段经历到经历库", "保存这段经历", "加入经历库", "添加经历到经历库", "添加经历", "帮我保存一段经历", "save this experience", "add experience"]);
}

function extractResumeText(message: string): string {
  return stripLead(message, ["导入简历文本", "导入简历", "这是我的简历", "import resume"]);
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
  return content.replace(/^[:：\s]+/, "").trim();
}

function parseExperience(content: string): { title: string; category: string; content: string } {
  return {
    title: content.split(/\r?\n/)[0]?.slice(0, 80) || "New experience",
    category: /\b(project|built|shipped|launched)\b/i.test(content) || content.includes("项目") ? "project" : "work",
    content,
  };
}

function capabilityDraft(locale: CopilotLocale): string {
  if (locale === "zh-CN") {
    return "我是 Coolto Copilot，一个求职和简历工作台助手。你可以自然地和我聊天；当你需要工作台操作时，我可以帮你整理经历、导入简历文本、保存 JD、根据 JD 生成定制简历版本、解释证据和风险、把采用的版本保存到简历草稿，并查看历史简历。";
  }
  return "I am Coolto Copilot, a job-search and resume workspace assistant. You can talk to me naturally, and when you ask for workspace actions I can help organize experiences, import resume text, save JDs, generate JD-tailored resume variants, explain evidence and risks, save an accepted version into a resume draft, and open your resume history.";
}

function careerAdviceDraft(locale: CopilotLocale): string {
  if (locale === "zh-CN") {
    return "可以。好的项目经历通常要交代四件事：你负责的问题、你采取的行动、关键技术选择，以及最终带来的可衡量结果。你可以先发一段很粗糙的描述，我会帮你整理成更适合简历的表达，再决定是否保存。";
  }
  return "Yes. A good project experience usually needs four parts: what problem you owned, what actions you took, what technical choices mattered, and what measurable result changed. Send me a rough paragraph, even if it is messy, and I can help you shape it into a stronger resume story before saving it.";
}

function buildSystemPrompt(): string {
  return [
    "You are Coolto Copilot's front desk job-search assistant.",
    "Return only valid JSON matching the FrontDeskDecision schema.",
    "Use chat_only for normal chat, product questions, confusion, and career advice.",
    "Use ask_clarification when a product operation is requested but required input is missing.",
    "Use use_product_tool or generate_resume_variants only when the user clearly asks for a workspace operation.",
    "Never expose tool names, internal intents, provider raw data, reasoning_content, or chain-of-thought in assistantDraft.",
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
