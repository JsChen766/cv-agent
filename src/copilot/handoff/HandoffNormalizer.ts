import { randomUUID } from "node:crypto";
import type { CopilotClientState, CopilotWorkspace } from "../types.js";
import type { FrontDeskHandoff, FrontDeskIntent, FrontDeskRoute } from "./FrontDeskHandoff.js";
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
    return {
      handoff: {
        ...parsed.data,
        sessionId: parsed.data.sessionId || input.sessionId,
        turnId: parsed.data.turnId || input.turnId,
        createdAt: parsed.data.createdAt || now,
      },
      repaired: false,
    };
  }

  const fallback = inferFallback(input, now);
  return {
    handoff: fallback,
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
  const routeTo = asRoute(raw?.routeTo as string | undefined) ?? explicitRoute ?? textSignals.routeTo;
  const active = input.clientState ?? {};
  const workspaceActive = input.workspace?.active;

  const handoff: FrontDeskHandoff = {
    id: stringField(raw?.id) ?? `handoff-${randomUUID()}`,
    sessionId: input.sessionId,
    turnId: input.turnId,
    intent: asIntent(raw?.intent) ?? textSignals.intent,
    routeTo,
    confidence: clamp(input.confidence ?? textSignals.confidence),
    userGoal: stringField(raw?.userGoal) ?? message.slice(0, 240),
    extracted: {
      jdText: stringField(rawExtracted.jdText) ?? textSignals.jdText,
      experienceText: stringField(rawExtracted.experienceText) ?? textSignals.experienceText,
      resumeText: stringField(rawExtracted.resumeText) ?? textSignals.resumeText,
      jdId: stringField(rawExtracted.jdId) ?? active.activeJDId ?? input.workspace?.jdId ?? workspaceActive?.jdId,
      experienceId: stringField(rawExtracted.experienceId) ?? active.activeExperienceId ?? workspaceActive?.experienceId,
      resumeId: stringField(rawExtracted.resumeId) ?? active.activeResumeId ?? input.workspace?.resumeId ?? workspaceActive?.resumeId,
      resumeItemId: stringField(rawExtracted.resumeItemId) ?? active.activeResumeItemId ?? workspaceActive?.resumeItemId,
      variantId: stringField(rawExtracted.variantId) ?? active.activeVariantId ?? input.workspace?.activeVariantId ?? workspaceActive?.variantId,
      targetRole: stringField(rawExtracted.targetRole) ?? textSignals.targetRole,
      company: stringField(rawExtracted.company) ?? textSignals.company,
      title: stringField(rawExtracted.title) ?? textSignals.title,
      keywords: stringArray(rawExtracted.keywords) ?? textSignals.keywords,
    },
    missingInputs: stringArray(raw?.missingInputs) ?? input.missingInputs,
    suggestedActions: suggestedActions(raw?.suggestedActions) ?? textSignals.suggestedActions,
    next: asNext(raw?.next) ?? textSignals.next,
    createdAt: now,
    raw,
  };

  if (input.responseType === "final") {
    handoff.intent = "general.chat";
    handoff.routeTo = "frontdesk";
    handoff.next = "answer_directly";
  }
  if (input.responseType === "ask_clarification") {
    handoff.intent = "clarify";
    handoff.next = "ask_clarification";
    handoff.missingInputs = handoff.missingInputs?.length ? handoff.missingInputs : ["intent"];
  }
  return handoff;
}

function asIntent(value: unknown): FrontDeskHandoff["intent"] | undefined {
  const values: FrontDeskHandoff["intent"][] = ["jd.intake", "jd.save", "jd.analyze", "resume.generate_from_jd", "experience.intake", "experience.save", "experience.rewrite", "resume.optimize_item", "resume.export", "general.chat", "clarify"];
  return typeof value === "string" && values.includes(value as FrontDeskHandoff["intent"]) ? value as FrontDeskHandoff["intent"] : undefined;
}

function asNext(value: unknown): FrontDeskHandoff["next"] | undefined {
  const values: FrontDeskHandoff["next"][] = ["answer_directly", "handoff", "ask_clarification", "prepare_confirmation", "execute_task"];
  return typeof value === "string" && values.includes(value as FrontDeskHandoff["next"]) ? value as FrontDeskHandoff["next"] : undefined;
}

function suggestedActions(value: unknown): FrontDeskHandoff["suggestedActions"] | undefined {
  const values: NonNullable<FrontDeskHandoff["suggestedActions"]>[number][] = ["save_jd", "analyze_jd", "match_experiences", "generate_resume", "save_experience", "rewrite_experience", "optimize_resume_item", "ask_clarification"];
  if (!Array.isArray(value)) return undefined;
  const actions = value.filter((item): item is NonNullable<FrontDeskHandoff["suggestedActions"]>[number] => typeof item === "string" && values.includes(item as NonNullable<FrontDeskHandoff["suggestedActions"]>[number]));
  return actions.length ? actions : undefined;
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
