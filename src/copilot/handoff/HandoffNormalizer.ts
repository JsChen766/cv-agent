import { randomUUID } from "node:crypto";
import type { CopilotClientState, CopilotWorkspace } from "../types.js";
import type {
  AssetGroundedConstraints,
  FrontDeskHandoff,
  FrontDeskIntent,
  FrontDeskRoute,
} from "./FrontDeskHandoff.js";
import { FrontDeskHandoffSchema } from "./FrontDeskHandoffSchema.js";

export type HandoffNormalizeInput = {
  raw: unknown;
  sessionId: string;
  turnId: string;
  userMessage: string;
  routeTo?: string;
  responseType?: string;
  confidence?: number;
  missingInputs?: string[];
  clientState?: CopilotClientState;
  workspace?: CopilotWorkspace | null;
};

export function normalizeFrontDeskHandoff(input: HandoffNormalizeInput): {
  handoff: FrontDeskHandoff;
  repaired: boolean;
  reason?: string;
} {
  const now = new Date().toISOString();
  const parsed = FrontDeskHandoffSchema.safeParse(input.raw);
  if (parsed.success) {
    const normalized = enrichHandoffWithUpload(input, {
      ...parsed.data,
      sessionId: parsed.data.sessionId || input.sessionId,
      turnId: parsed.data.turnId || input.turnId,
      createdAt: parsed.data.createdAt || now,
    });
    const reconciled = reconcileParsedHandoffWithTextSignals(input, normalized);
    return {
      handoff: reconciled.handoff,
      repaired: reconciled.repaired,
      reason: reconciled.reason,
    };
  }

  const fallback = inferFallback(input, now);
  return {
    handoff: enrichHandoffWithUpload(input, fallback),
    repaired: true,
    reason: input.raw === undefined ? "missing_handoff" : "invalid_handoff_schema",
  };
}

function inferFallback(input: HandoffNormalizeInput, now: string): FrontDeskHandoff {
  const message = input.userMessage.trim();
  const explicitRoute = asRoute(input.routeTo);
  const textSignals = classifyMessage(message);
  const raw = toRawRecord(input.raw);
  const rawExtracted = isRecord(raw?.extracted) ? raw.extracted : {};
  const rawConstraints = isRecord(raw?.constraints) ? raw.constraints : undefined;
  const intentFromRaw = asIntent(raw?.intent);
  const promotedByTextSignals = shouldPromoteIntent(intentFromRaw, textSignals.intent);
  const intent = promotedByTextSignals ? textSignals.intent : (intentFromRaw ?? textSignals.intent);
  const routeTo = promotedByTextSignals
    ? (defaultRouteForIntent(intent) ?? textSignals.routeTo)
    : (asRoute(raw?.routeTo as string | undefined)
      ?? explicitRoute
      ?? defaultRouteForIntent(intent)
      ?? textSignals.routeTo);
  const active = input.clientState ?? {};
  const workspaceActive = input.workspace?.active;

  const handoff: FrontDeskHandoff = {
    id: stringField(raw?.id) ?? `handoff-${randomUUID()}`,
    sessionId: input.sessionId,
    turnId: input.turnId,
    intent,
    routeTo,
    confidence: clamp(input.confidence ?? textSignals.confidence),
    userGoal: stringField(raw?.userGoal) ?? message.slice(0, 240),
    goal: stringField(raw?.goal) ?? textSignals.goal,
    outputType: stringField(raw?.outputType) ?? textSignals.outputType,
    constraints: pickConstraints(rawConstraints) ?? textSignals.constraints,
    extracted: {
      jdText: stringField(rawExtracted.jdText) ?? textSignals.jdText,
      experienceText: stringField(rawExtracted.experienceText) ?? textSignals.experienceText,
      resumeText: stringField(rawExtracted.resumeText) ?? textSignals.resumeText,
      jdId: stringField(rawExtracted.jdId) ?? active.activeJDId ?? input.workspace?.jdId ?? workspaceActive?.jdId,
      experienceId: stringField(rawExtracted.experienceId) ?? active.activeExperienceId ?? workspaceActive?.experienceId,
      experienceIds: stringArray(rawExtracted.experienceIds),
      experienceQuery: stringField(rawExtracted.experienceQuery) ?? textSignals.experienceQuery,
      resumeId: stringField(rawExtracted.resumeId) ?? active.activeResumeId ?? input.workspace?.resumeId ?? workspaceActive?.resumeId,
      resumeItemId: stringField(rawExtracted.resumeItemId) ?? active.activeResumeItemId ?? workspaceActive?.resumeItemId,
      fileId: stringField(rawExtracted.fileId),
      resumeFileId: stringField(rawExtracted.resumeFileId),
      originalName: stringField(rawExtracted.originalName),
      variantId: stringField(rawExtracted.variantId) ?? active.activeVariantId ?? input.workspace?.activeVariantId ?? workspaceActive?.variantId,
      targetRole: stringField(rawExtracted.targetRole) ?? textSignals.targetRole,
      company: stringField(rawExtracted.company) ?? textSignals.company,
      title: stringField(rawExtracted.title) ?? textSignals.title,
      keywords: stringArray(rawExtracted.keywords) ?? textSignals.keywords,
    },
    missingInputs: stringArray(raw?.missingInputs) ?? input.missingInputs,
    suggestedActions: promotedByTextSignals
      ? textSignals.suggestedActions
      : (suggestedActions(raw?.suggestedActions) ?? textSignals.suggestedActions),
    next: promotedByTextSignals
      ? textSignals.next
      : (asNext(raw?.next) ?? textSignals.next),
    createdAt: now,
    raw,
  };

  if (input.responseType === "final" && textSignals.intent === "general.chat") {
    handoff.intent = "general.chat";
    handoff.routeTo = "frontdesk";
    handoff.next = "answer_directly";
  }
  if (input.responseType === "ask_clarification" && textSignals.intent === "general.chat") {
    handoff.intent = "clarify";
    handoff.next = "ask_clarification";
    handoff.missingInputs = handoff.missingInputs?.length ? handoff.missingInputs : ["intent"];
  }
  return handoff;
}

function reconcileParsedHandoffWithTextSignals(
  input: HandoffNormalizeInput,
  handoff: FrontDeskHandoff,
): { handoff: FrontDeskHandoff; repaired: boolean; reason?: string } {
  const textSignals = classifyMessage(input.userMessage.trim());
  if (!shouldPromoteParsedHandoff(handoff, textSignals.intent)) {
    return { handoff, repaired: false };
  }

  const active = input.clientState ?? {};
  const workspaceActive = input.workspace?.active;
  return {
    handoff: {
      ...handoff,
      intent: textSignals.intent,
      routeTo: textSignals.routeTo,
      confidence: Math.max(handoff.confidence, textSignals.confidence),
      goal: handoff.goal ?? textSignals.goal,
      outputType: handoff.outputType ?? textSignals.outputType,
      constraints: handoff.constraints ?? textSignals.constraints,
      extracted: {
        ...handoff.extracted,
        jdText: handoff.extracted.jdText ?? textSignals.jdText,
        experienceText: handoff.extracted.experienceText ?? textSignals.experienceText,
        resumeText: handoff.extracted.resumeText ?? textSignals.resumeText,
        jdId: handoff.extracted.jdId ?? active.activeJDId ?? input.workspace?.jdId ?? workspaceActive?.jdId,
        experienceId: handoff.extracted.experienceId ?? active.activeExperienceId ?? workspaceActive?.experienceId,
        experienceQuery: handoff.extracted.experienceQuery ?? textSignals.experienceQuery,
        resumeId: handoff.extracted.resumeId ?? active.activeResumeId ?? input.workspace?.resumeId ?? workspaceActive?.resumeId,
        resumeItemId: handoff.extracted.resumeItemId ?? active.activeResumeItemId ?? workspaceActive?.resumeItemId,
        variantId: handoff.extracted.variantId ?? active.activeVariantId ?? input.workspace?.activeVariantId ?? workspaceActive?.variantId,
        targetRole: handoff.extracted.targetRole ?? textSignals.targetRole,
        company: handoff.extracted.company ?? textSignals.company,
        title: handoff.extracted.title ?? textSignals.title,
        keywords: handoff.extracted.keywords ?? textSignals.keywords,
      },
      suggestedActions: textSignals.suggestedActions ?? handoff.suggestedActions,
      next: textSignals.next,
    },
    repaired: true,
    reason: "text_signal_route_override",
  };
}

function shouldPromoteParsedHandoff(handoff: FrontDeskHandoff, textIntent: FrontDeskIntent): boolean {
  return shouldPromoteIntent(handoff.intent, textIntent);
}

function shouldPromoteIntent(rawIntent: FrontDeskIntent | undefined, textIntent: FrontDeskIntent): boolean {
  if (!rawIntent || rawIntent === textIntent || textIntent === "general.chat") return false;
  if (rawIntent === "general.chat" || rawIntent === "clarify") return true;
  return rawIntent === "jd.intake"
    && (textIntent === "resume.generate_from_jd" || textIntent === "experience.match_against_jd");
}

function enrichHandoffWithUpload(input: HandoffNormalizeInput, handoff: FrontDeskHandoff): FrontDeskHandoff {
  const upload = uploadFromClientState(input.clientState);
  if (!upload.fileId && !upload.originalName) return handoff;
  return {
    ...handoff,
    extracted: {
      ...handoff.extracted,
      fileId: handoff.extracted.fileId ?? upload.fileId,
      resumeFileId: handoff.extracted.resumeFileId ?? upload.fileId,
      originalName: handoff.extracted.originalName ?? upload.originalName,
    },
  };
}

function uploadFromClientState(clientState: CopilotClientState | undefined): { fileId?: string; originalName?: string } {
  if (!clientState) return {};
  const resumeUpload: Record<string, unknown> | undefined = isRecord(clientState.resumeUpload) ? clientState.resumeUpload : undefined;
  const fileId =
    stringField(resumeUpload?.fileId)
    ?? stringField(resumeUpload?.id)
    ?? stringField(clientState.activeFileId)
    ?? stringField(clientState.resumeFileId)
    ?? stringField(clientState.uploadedFileId)
    ?? stringField(clientState.fileId);
  const originalName =
    stringField(resumeUpload?.originalName)
    ?? stringField(resumeUpload?.fileName)
    ?? stringField(resumeUpload?.name)
    ?? stringField(clientState.originalName)
    ?? stringField(clientState.fileName);
  return { fileId, originalName };
}

const ALL_INTENTS: FrontDeskIntent[] = [
  "jd.intake",
  "jd.save",
  "jd.analyze",
  "resume.generate_from_jd",
  "experience.intake",
  "experience.save",
  "experience.rewrite",
  "experience.match_against_jd",
  "asset_grounded.write",
  "resume.optimize_item",
  "resume.export",
  "general.chat",
  "clarify",
];

function asIntent(value: unknown): FrontDeskHandoff["intent"] | undefined {
  return typeof value === "string" && (ALL_INTENTS as string[]).includes(value)
    ? value as FrontDeskHandoff["intent"]
    : undefined;
}

/**
 * Default specialist route for an intent when prompt/normalizer gave no
 * routeTo. Phase 1: `experience.match_against_jd` is owned by
 * experience_receiver (it already exposes `match_experiences_against_jd` in
 * its allowedTools), and `asset_grounded.write` is owned by architect by
 * default. Phase 3 will further open allowedTools for these intents.
 */
function defaultRouteForIntent(intent: FrontDeskIntent): FrontDeskRoute | undefined {
  switch (intent) {
    case "jd.intake":
    case "jd.save":
    case "jd.analyze":
      return "strategist";
    case "experience.intake":
    case "experience.save":
    case "experience.rewrite":
    case "experience.match_against_jd":
      return "experience_receiver";
    case "resume.generate_from_jd":
    case "resume.optimize_item":
    case "resume.export":
    case "asset_grounded.write":
      return "architect";
    case "general.chat":
    case "clarify":
      return "frontdesk";
    default:
      return undefined;
  }
}

function asNext(value: unknown): FrontDeskHandoff["next"] | undefined {
  const values: FrontDeskHandoff["next"][] = ["answer_directly", "handoff", "ask_clarification", "prepare_confirmation", "execute_task"];
  return typeof value === "string" && values.includes(value as FrontDeskHandoff["next"]) ? value as FrontDeskHandoff["next"] : undefined;
}

function suggestedActions(value: unknown): FrontDeskHandoff["suggestedActions"] | undefined {
  const values: NonNullable<FrontDeskHandoff["suggestedActions"]>[number][] = [
    "save_jd",
    "analyze_jd",
    "match_experiences",
    "generate_resume",
    "save_experience",
    "rewrite_experience",
    "optimize_resume_item",
    "compose_career_text",
    "ask_clarification",
  ];
  if (!Array.isArray(value)) return undefined;
  const actions = value.filter((item): item is NonNullable<FrontDeskHandoff["suggestedActions"]>[number] => typeof item === "string" && values.includes(item as NonNullable<FrontDeskHandoff["suggestedActions"]>[number]));
  return actions.length ? actions : undefined;
}

function pickConstraints(value: Record<string, unknown> | undefined): AssetGroundedConstraints | undefined {
  if (!value) return undefined;
  const length = oneOf(value.length, ["short", "medium", "long"] as const);
  const language = oneOf(value.language, ["zh", "en", "auto"] as const);
  const format = oneOf(value.format, ["paragraph", "bullets", "script", "email", "answer"] as const);
  const tone = stringField(value.tone);
  const audience = stringField(value.audience);
  const out: AssetGroundedConstraints = {};
  if (length) out.length = length;
  if (language) out.language = language;
  if (format) out.format = format;
  if (tone) out.tone = tone;
  if (audience) out.audience = audience;
  return Object.keys(out).length ? out : undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return items.length ? items : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function classifyMessage(message: string): {
  intent: FrontDeskIntent;
  routeTo: FrontDeskRoute;
  confidence: number;
  jdText?: string;
  experienceText?: string;
  resumeText?: string;
  targetRole?: string;
  company?: string;
  title?: string;
  keywords?: string[];
  goal?: string;
  outputType?: string;
  constraints?: AssetGroundedConstraints;
  experienceQuery?: string;
  suggestedActions?: FrontDeskHandoff["suggestedActions"];
  next: FrontDeskHandoff["next"];
} {
  const lower = message.toLowerCase();
  const looksLikeJD = message.length > 120 && (
    lower.includes("job description")
    || lower.includes("responsibilities")
    || lower.includes("requirements")
    || lower.includes("qualifications")
    || lower.includes("jd")
    || message.includes("岗位职责")
    || message.includes("任职要求")
    || message.includes("职位描述")
  );

  // Phase 1: detect asset-grounded writing FIRST so phrases like
  // "based on this JD write a self-intro" don't fall through to
  // resume.generate_from_jd, and so phrases like "based on my experiences
  // write a self-intro" don't fall through to experience.intake. The
  // detection is conservative: it only fires when the message has a clear
  // writing verb plus an asset-grounded scope marker, otherwise we fall
  // back to legacy heuristics below to keep existing routing untouched.
  const writing = detectAssetGroundedWriting(message);
  if (writing) {
    return {
      intent: "asset_grounded.write",
      routeTo: "architect",
      confidence: 0.74,
      goal: writing.goal,
      outputType: writing.outputType,
      constraints: writing.constraints,
      experienceQuery: writing.experienceQuery,
      jdText: writing.jdText ?? (looksLikeJD ? message : undefined),
      suggestedActions: ["compose_career_text"],
      next: "execute_task",
    };
  }

  // Phase 1: detect JD-experience matching BEFORE resume generation so
  // phrases like "哪些经历最匹配这份 JD" don't fall through to
  // resume.generate_from_jd. This also fixes the prompt-vs-schema drift
  // identified in Phase 0 (frontdesk.md mentioned experience.match_against_jd
  // but the schema didn't accept it).
  if (detectMatchAgainstJD(message, lower)) {
    return {
      intent: "experience.match_against_jd",
      routeTo: "experience_receiver",
      confidence: 0.78,
      jdText: looksLikeJD ? message : undefined,
      ...(looksLikeJD ? extractJDHints(message) : {}),
      suggestedActions: ["match_experiences"],
      next: "execute_task",
    };
  }

  const wantsGenerate = lower.includes("generate") || lower.includes("resume") || lower.includes("cv") || message.includes("生成") || message.includes("简历") || message.includes("那就生成");
  const wantsRewriteExperience = lower.includes("rewrite") || lower.includes("optimize this experience") || message.includes("改写") || message.includes("优化这") || message.includes("当前经历") || message.includes("这条经历") || message.includes("这份经历");

  if (looksLikeJD && wantsGenerate) {
    return {
      intent: "resume.generate_from_jd",
      routeTo: "architect",
      confidence: 0.78,
      jdText: message,
      ...extractJDHints(message),
      suggestedActions: ["generate_resume"],
      next: "execute_task",
    };
  }
  if (looksLikeJD) {
    return {
      intent: "jd.intake",
      routeTo: "strategist",
      confidence: 0.76,
      jdText: message,
      ...extractJDHints(message),
      suggestedActions: ["save_jd", "analyze_jd", "generate_resume"],
      next: "handoff",
    };
  }
  if (wantsGenerate) {
    return {
      intent: "resume.generate_from_jd",
      routeTo: "architect",
      confidence: 0.7,
      suggestedActions: ["generate_resume"],
      next: "execute_task",
    };
  }
  if (wantsRewriteExperience) {
    return {
      intent: "experience.rewrite",
      routeTo: "experience_receiver",
      confidence: 0.72,
      suggestedActions: ["rewrite_experience"],
      next: "execute_task",
    };
  }
  if (message.length > 80 && (message.includes("经历") || lower.includes("experience") || lower.includes("project"))) {
    return {
      intent: "experience.intake",
      routeTo: "experience_receiver",
      confidence: 0.68,
      experienceText: message,
      suggestedActions: ["save_experience", "rewrite_experience"],
      next: "handoff",
    };
  }
  return {
    intent: "general.chat",
    routeTo: "frontdesk",
    confidence: 0.55,
    next: "answer_directly",
  };
}

function extractJDHints(text: string): { targetRole?: string; company?: string; title?: string; keywords?: string[] } {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const titleLine = lines.find((line) => /title|职位|岗位|role/i.test(line)) ?? lines[0];
  const companyLine = lines.find((line) => /company|公司/i.test(line));
  const targetRole = readAfterColon(titleLine);
  return {
    targetRole: targetRole || titleLine?.slice(0, 80),
    title: titleLine?.slice(0, 120),
    company: companyLine ? readAfterColon(companyLine) || companyLine.slice(0, 80) : undefined,
    keywords: keywordHints(text),
  };
}

function keywordHints(text: string): string[] | undefined {
  const candidates = ["React", "Vue", "TypeScript", "Node", "Python", "SQL", "AI", "LLM", "数据", "产品", "增长"];
  const found = candidates.filter((word) => text.toLowerCase().includes(word.toLowerCase()));
  return found.length ? found.slice(0, 8) : undefined;
}

function readAfterColon(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/[:：]\s*(.+)$/);
  return match?.[1]?.trim();
}

function asRoute(value: string | undefined): FrontDeskRoute | undefined {
  if (value === "frontdesk" || value === "strategist" || value === "experience_receiver" || value === "architect" || value === "critic") return value;
  return undefined;
}

function toRawRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

// ─── Phase 1 asset-grounded writing detection helpers ───────────────────────

/**
 * Verb cues that strongly imply "produce a piece of text". Includes Chinese
 * and English variants. Excludes pure rewrite verbs (改写 / 优化经历) because
 * those map to the existing experience.rewrite flow.
 */
const WRITING_VERB_PATTERNS: RegExp[] = [
  /写(一)?[条段份个]?(自我介绍|项目介绍|面试|开场白|开场|个人优势|总结|介绍|自荐|cover\s*letter|email|邮件|回答)/i,
  /帮(我|忙)?写/,
  /生成(一段|一条|一份)?(自我介绍|项目介绍|面试|开场|个人优势|cover\s*letter)/i,
  /(写|起草|草拟|撰写)\s*(一)?[段份]/,
  /(self[-\s]?intro|cover\s*letter|elevator\s*pitch|interview\s*answer|application\s*answer|profile\s*summary)/i,
  /(write|draft|compose|generate)\s+(a|an|one|me)?\s*(short|brief|quick|one[-\s]?minute)?\s*(self[-\s]?intro|introduction|pitch|cover\s*letter|interview\s*answer|application\s*answer|summary|paragraph)/i,
  /帮我(总结|提炼|表达|说一下|写)/,
  /把.*(改|改成|转成|说成).*(面试|口语|话|回答|介绍)/,
  /(根据|基于).{0,40}(经历|项目|实习|工作).{0,12}(总结|提炼|凝练|说一下|介绍一下|写)/,
];

/**
 * Asset-grounded scope markers — the message must reference the user's own
 * assets (经历/简历/项目/JD/this resume/etc.). We require at least one of
 * these in addition to a writing verb so that pure chitchat ("帮我写个段子")
 * still goes to general.chat instead of asset_grounded.write.
 */
const ASSET_SCOPE_PATTERNS: RegExp[] = [
  /经历/,
  /简历/,
  /项目/,
  /实习/,
  /工作/,
  /\bjd\b/i,
  /\bresume\b/i,
  /\bcv\b/i,
  /\bexperience\b/i,
  /(my|这份|这条|这段|那条|那段|当前|刚才那个)/,
  /(根据|基于)/,
];

const OUTPUT_TYPE_PATTERNS: Array<{ test: RegExp; outputType: string }> = [
  { test: /(自我介绍|self[-\s]?intro|introduction)/i, outputType: "self_intro" },
  { test: /(项目介绍|项目说明|project\s*intro|project\s*introduction)/i, outputType: "project_intro" },
  { test: /(面试|interview)/i, outputType: "interview_answer" },
  { test: /(cover\s*letter|求职信)/i, outputType: "cover_letter" },
  { test: /(申请表|application\s*answer)/i, outputType: "application_answer" },
  { test: /(个人优势|总结优势|profile\s*summary|个人简介)/i, outputType: "profile_summary" },
  { test: /(一句话|一分钟|elevator\s*pitch|pitch)/i, outputType: "pitch" },
];

const LENGTH_PATTERNS: Array<{ test: RegExp; length: "short" | "medium" | "long" }> = [
  { test: /(一句话|两句话|短一点|brief|short|one[-\s]?liner)/i, length: "short" },
  { test: /(一分钟|1\s*分钟|medium|中等)/i, length: "medium" },
  { test: /(详细|长一点|long|展开|完整)/i, length: "long" },
];

const LANGUAGE_PATTERNS: Array<{ test: RegExp; language: "zh" | "en" }> = [
  { test: /(英文|english|英语|in\s*english)/i, language: "en" },
  { test: /(中文|chinese|中文版)/i, language: "zh" },
];

function detectAssetGroundedWriting(message: string): {
  outputType?: string;
  goal?: string;
  constraints?: AssetGroundedConstraints;
  experienceQuery?: string;
  jdText?: string;
} | undefined {
  const hasWritingVerb = WRITING_VERB_PATTERNS.some((re) => re.test(message));
  if (!hasWritingVerb) return undefined;
  const hasAssetScope = ASSET_SCOPE_PATTERNS.some((re) => re.test(message));
  if (!hasAssetScope) return undefined;

  // Don't hijack "改写这条经历" / "优化这份经历" — those are
  // experience.rewrite. We only release this guard if the message ALSO
  // contains an explicit writing-output marker (interview, self-intro, etc.).
  if (/改写|优化这[条份]|当前经历|这条经历|这份经历/.test(message)
      && !/(自我介绍|项目介绍|面试|开场|cover|总结|个人优势|application|introduction|pitch)/i.test(message)) {
    return undefined;
  }

  const outputType = OUTPUT_TYPE_PATTERNS.find((p) => p.test.test(message))?.outputType ?? "custom";
  const lengthHit = LENGTH_PATTERNS.find((p) => p.test.test(message))?.length;
  const languageHit = LANGUAGE_PATTERNS.find((p) => p.test.test(message))?.language;
  const constraints: AssetGroundedConstraints = {};
  if (lengthHit) constraints.length = lengthHit;
  if (languageHit) constraints.language = languageHit;

  // Free-form experience keyword (e.g. "WEEX") so the specialist (Phase 3+)
  // can resolve it via AssetMentionResolver.
  const experienceQuery = extractExperienceQuery(message);

  // If the message also looks like a pasted JD ("根据这份 JD 写一段
  // 自我介绍：<JD 文本>"), surface jdText so the writing tool (Phase 2+)
  // can ground on it.
  let jdText: string | undefined;
  if (message.length > 200 && (
    message.includes("岗位职责")
    || message.includes("任职要求")
    || message.includes("职位描述")
    || /job description|responsibilities|requirements|qualifications/i.test(message)
  )) {
    jdText = message;
  }

  return {
    outputType,
    goal: outputType,
    constraints: Object.keys(constraints).length ? constraints : undefined,
    experienceQuery,
    jdText,
  };
}

/**
 * Detect "match my experiences against this JD" intent. Conservative:
 * requires both an explicit match-verb and a JD-or-position reference so
 * we don't compete with resume.generate_from_jd.
 */
function detectMatchAgainstJD(message: string, lower: string): boolean {
  const hasMatchVerb =
    /(哪些|哪条|哪段|哪份)?(经历|项目|实习).{0,8}(最)?(匹配|适合|契合)/.test(message)
    || /匹配度/.test(message)
    || /match\s+(my\s+)?experiences?/i.test(message)
    || /which\s+experiences?\s+(best\s+)?(fit|match)/i.test(message)
    || lower.includes("matching degree");
  if (!hasMatchVerb) return false;
  // Must reference JD/JDs/this position so generic "match" verbs don't fire.
  const hasJDScope =
    /(这份|那份|这个|那个|这条|当前)?\s*jd/i.test(message)
    || /\bjob\s+description\b/i.test(message)
    || /\bposition\b/i.test(message)
    || /岗位|职位/.test(message);
  return hasJDScope;
}

/**
 * Extract a free-form experience keyword ("WEEX" / "字节实习") so Phase 3+
 * specialists can resolve it via AssetMentionResolver. Returns undefined
 * when the message has no obvious named entity.
 */
function extractExperienceQuery(message: string): string | undefined {
  // Pattern A: "根据/基于 <token> 实习/项目/经历/工作"
  const cnExp = message.match(/(?:根据|基于)\s*(?:我的|这份|这条|这段|这个)?\s*([\u4e00-\u9fffA-Za-z0-9_\- ]{1,32}?)\s*(?:经历|实习|项目|工作)/);
  if (cnExp && cnExp[1]) {
    const candidate = cnExp[1].trim();
    if (candidate.length > 0 && candidate.length <= 32) return candidate;
  }
  // Pattern B: "based on my <token> experience"
  const enExp = message.match(/based on my\s+([A-Za-z0-9_\- ]{1,32})\s+(experience|internship|project|role)/i);
  if (enExp && enExp[1]) return enExp[1].trim();
  return undefined;
}
