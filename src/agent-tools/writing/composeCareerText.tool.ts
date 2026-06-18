import type { z } from "zod";
import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import type {
  ToolResult,
  ToolResultEntity,
  ToolResultEvidence,
  ToolResultNextActionHint,
} from "../../agent-core/tools/ToolResult.js";
import type { AgentContext } from "../../agent-core/runtime/AgentContext.js";
import type { ModelClient } from "../../agent-core/model/ModelClient.js";
import type { ModelClientChatRequest } from "../../agent-core/model/types.js";
import { PromptRegistry } from "../../agent-core/prompts/PromptRegistry.js";
import {
  ComposeCareerTextInputSchema,
  ToolResultSchema,
} from "../../agent-core/validation/ToolInputSchemas.js";
import { AssetMentionResolver } from "../../copilot/context/AssetMentionResolver.js";
import {
  isCanonicalExperienceId,
  isCanonicalJDId,
  isCanonicalResumeId,
} from "../../copilot/context/IdGuards.js";
import { isDeterministicFallbackAllowed } from "../../product/deterministicFallbackGuard.js";
import type { EvidencePack } from "../../rag/evidence/types.js";
import type { InstructionPack } from "../../rag/guideline/types.js";
import type { PersonalizationPack } from "../../self-evolution/preference/types.js";
import {
  buildEvidenceOutcome,
  buildGuidelineOutcome,
  buildPersonalizationOutcome,
  type GroundingDiagnostics as ExternalGroundingDiagnostics,
  type ResolvedExperienceLite,
} from "./composeGroundingHelpers.js";

type ComposeCareerTextInput = z.infer<typeof ComposeCareerTextInputSchema>;
type ComposeConstraints = NonNullable<ComposeCareerTextInput["constraints"]>;

/**
 * Phase 2 — \`compose_career_text\`
 *
 * High-cohesion, read-only writing tool that turns the user's real assets
 * (experiences / active resume / JD / RAG evidence / preference bank) into a
 * grounded piece of job-search text.
 *
 * It deliberately does NOT:
 *   - save / accept / export / generate variants;
 *   - mutate \`workspacePatch\` keys that affect the workspace;
 *   - create a pendingAction;
 *   - call \`match_experiences_against_jd\` or \`generate_resume_from_jd\`.
 *
 * Phase 3 will decide whether to add this tool to the Architect /
 * ExperienceReceiver \`allowedTools\`. Phase 2 only registers it inside the
 * tool registry so it can be smoke-tested end-to-end.
 */
export function composeCareerTextTool(): ToolDefinition {
  return {
    name: "compose_career_text",
    description:
      "Compose a short asset-grounded job-search text (self-intro, project intro, interview answer, cover letter, profile summary, application answer, pitch, or a custom flavor). Read-only; never invents facts; never mutates assets.",
    ownerAgent: "architect",
    inputSchema: ComposeCareerTextInputSchema,
    outputSchema: ToolResultSchema,
    mutability: "read",
    requiresConfirmation: false,
    riskLevel: "low",
    execute: async (rawInput, context) => composeCareerTextExecute(rawInput, context),
  };
}

const KNOWN_OUTPUT_TYPES = [
  "self_intro",
  "interview_answer",
  "cover_letter",
  "profile_summary",
  "project_intro",
  "application_answer",
  "pitch",
  "custom",
] as const;

type ResolvedExperience = {
  id: string;
  title: string;
  organization?: string;
  role?: string;
  category?: string;
  startDate?: string;
  endDate?: string;
  tags: string[];
  content: string;
  structured?: Record<string, unknown>;
};

type ResolvedScope = {
  experiences: ResolvedExperience[];
  resumeId?: string;
  resumeTitle?: string;
  resumeText?: string;
  jdId?: string;
  jdText?: string;
  jdTitle?: string;
};

type WritingResult = {
  title: string;
  outputType: string;
  content: string;
  alternatives: Array<{ title: string; content: string; scenario?: string }>;
  usedExperienceIds: string[];
  usedResumeIds: string[];
  usedJDIds: string[];
  usedEvidenceIds: string[];
  groundingNotes: string[];
  riskNotes: string[];
  suggestions: string[];
};

type ComposeContext = {
  userInstruction: string;
  goal?: string;
  outputType: string;
  constraints: ComposeConstraints;
  scope: ResolvedScope;
  personalization?: PersonalizationPack;
  evidencePack?: EvidencePack;
  instructionPack?: InstructionPack;
  styleRules?: string[];
};

/**
 * Phase 4 — diagnostic record for grounding signal acquisition.
 *
 * Re-exported from `composeGroundingHelpers.ts` so the rest of this file can
 * keep referring to the same type. Each `status` is a stable token so
 * downstream observability (LearningEvent, AgentRoomEvent, etc.) can
 * pattern-match without parsing free text.
 */
type GroundingDiagnostics = ExternalGroundingDiagnostics;

async function composeCareerTextExecute(
  rawInput: Record<string, unknown>,
  context: AgentContext,
): Promise<ToolResult> {
  const input = ComposeCareerTextInputSchema.parse(rawInput ?? {});
  const goal = stringField(input.goal);
  const userInstruction = stringField(input.userInstruction) ?? context.userMessage ?? "";
  const outputType = normalizeOutputType(input.outputType);
  const constraints = (input.constraints ?? {}) as ComposeConstraints;
  const languageHint = constraints.language ?? "auto";

  const scope = await resolveScope({
    context,
    assetScope: input.assetScope,
    experienceQuery: stringField(input.experienceQuery),
    jdText: stringField(input.jdText),
  });

  const hasExperienceScope = scope.experiences.length > 0;
  const hasJDScope = Boolean(scope.jdText);
  const hasResumeScope = Boolean(scope.resumeText);
  const requestedExperienceQuery = stringField(input.experienceQuery);
  const rawRequestedExperienceIds = input.assetScope?.experienceIds ?? [];
  // We treat the caller as having "asked for a specific experience" whenever
  // they supplied any experienceIds (canonical or not) OR an experienceQuery.
  // Non-canonical strings are filtered out by the canonical-id guard, so the
  // tool will report \`experience_not_resolved\` instead of silently degrading
  // into the no-asset branch — preventing the LLM from inventing content.
  const askedSpecificExperience =
    Boolean(requestedExperienceQuery) || rawRequestedExperienceIds.length > 0;

  // 1. Caller asked for a specific experience but we couldn't resolve any.
  if (askedSpecificExperience && !hasExperienceScope) {
    return needsInputResult({
      reason: "experience_not_resolved",
      message: requestedExperienceQuery
        ? "没有找到与 \"" + requestedExperienceQuery + "\" 匹配的经历。请先在经历库中保存这条经历，或换个关键词。"
        : "没有找到指定的经历。请先确认 experienceId 是否正确，或在经历库中保存这条经历。",
      missingInputs: ["experienceId"],
      outputType,
      requestedExperienceQuery,
    });
  }

  // 2. No experience, no JD, no resume — nothing to ground on.
  if (!hasExperienceScope && !hasJDScope && !hasResumeScope) {
    return needsInputResult({
      reason: "no_assets",
      message:
        "我目前看不到可用于写作的真实素材。请先保存几条经历、提供一份 JD，或选择一份简历，我再来基于它们生成内容。",
      missingInputs: ["experienceText", "jdText"],
      outputType,
    });
  }

  // 3. Optional grounding signals (Phase 4 — diagnostics-aware).
  const personalizationOutcome = await buildPersonalizationOutcome(context, {
    language: languageHint,
    outputType,
    tone: constraints.tone,
  });
  const evidenceOutcome = await buildEvidenceOutcome(context, {
    jdText: scope.jdText,
    experiences: scope.experiences as ResolvedExperienceLite[],
  });
  const guidelineOutcome = await buildGuidelineOutcome(context, {
    outputType,
    constraints,
    jdText: scope.jdText,
    pseudoSeed: scope.experiences.length > 0
      ? scope.experiences.slice(0, 2).map((e) => e.title + " " + (e.role ?? "") + " " + e.tags.join(" ")).join("\n")
      : undefined,
    targetRole: scope.jdTitle,
  });

  const personalization = personalizationOutcome.pack;
  const evidencePack = evidenceOutcome.pack;
  const instructionPack = guidelineOutcome.pack;
  const styleRules = guidelineOutcome.styleRules;

  const diagnostics: GroundingDiagnostics = {
    evidenceRag: evidenceOutcome.diagnostics,
    guidelineRag: guidelineOutcome.diagnostics,
    preferenceBank: personalizationOutcome.diagnostics,
  };

  // 4. Compose.
  const modelClient = context.kernel.frontDeskModelClient;
  let writing: WritingResult;
  let composeMethod: "llm" | "deterministic_test_fallback" = "llm";

  if (modelClient) {
    try {
      writing = await composeWithLLM({
        modelClient,
        userInstruction,
        goal,
        outputType,
        constraints,
        scope,
        personalization,
        evidencePack,
        instructionPack,
        styleRules,
      });
    } catch (error) {
      if (!isDeterministicFallbackAllowed()) {
        return llmFailedResult(error, outputType, scope);
      }
      writing = composeDeterministic({ userInstruction, goal, outputType, constraints, scope, personalization, evidencePack, instructionPack, styleRules });
      composeMethod = "deterministic_test_fallback";
    }
  } else if (isDeterministicFallbackAllowed()) {
    writing = composeDeterministic({ userInstruction, goal, outputType, constraints, scope, personalization, evidencePack, instructionPack, styleRules });
    composeMethod = "deterministic_test_fallback";
  } else {
    return llmNotConfiguredResult(outputType);
  }

  return buildSuccessResult({ writing, scope, evidencePack, personalization, instructionPack, composeMethod, diagnostics });
}

async function resolveScope(input: {
  context: AgentContext;
  assetScope?: { experienceIds?: string[]; resumeId?: string; jdId?: string };
  experienceQuery?: string;
  jdText?: string;
}): Promise<ResolvedScope> {
  const { context, assetScope } = input;
  const userId = context.userId;
  const services = context.kernel.productServices;

  // ── Experience resolution ──────────────────────────────────────────
  const explicitIds = (assetScope?.experienceIds ?? []).filter(isCanonicalExperienceId);
  let experiences: ResolvedExperience[] = [];

  if (explicitIds.length > 0) {
    experiences = await loadExperiencesById(context, explicitIds);
  } else if (input.experienceQuery && context.userAssetContext) {
    const resolver = new AssetMentionResolver();
    const result = resolver.matchExperience(input.experienceQuery, context.userAssetContext);
    if (result.status === "unique" && result.match) {
      experiences = await loadExperiencesById(context, [result.match.id]);
    } else {
      experiences = [];
    }
  } else if (
    context.userAssetContext?.active.experienceId
    && isCanonicalExperienceId(context.userAssetContext.active.experienceId)
  ) {
    experiences = await loadExperiencesById(context, [context.userAssetContext.active.experienceId]);
  } else {
    try {
      const all = await services.experienceService.listExperiences(userId, { limit: 12 });
      experiences = all.map((exp) => ({
        id: exp.id,
        title: exp.title,
        organization: exp.organization,
        role: exp.role,
        category: exp.category,
        startDate: exp.startDate,
        endDate: exp.endDate,
        tags: exp.tags ?? [],
        content: typeof exp.content === "string" ? exp.content : "",
        structured: exp.structured as Record<string, unknown> | undefined,
      }));
    } catch {
      experiences = [];
    }
  }

  // ── JD resolution ──────────────────────────────────────────────────
  let jdId: string | undefined;
  let jdText: string | undefined;
  let jdTitle: string | undefined;
  if (input.jdText && input.jdText.trim()) {
    jdText = input.jdText.trim();
  }
  const candidateJDId = assetScope?.jdId && isCanonicalJDId(assetScope.jdId) ? assetScope.jdId : undefined;
  if (candidateJDId) {
    try {
      const jd = await services.jdService.getJD(userId, candidateJDId);
      if (jd) {
        jdId = jd.id;
        jdTitle = jd.title ?? jd.targetRole;
        if (!jdText) jdText = jd.rawText;
      }
    } catch {
      // ignore
    }
  }
  if (!jdId && context.userAssetContext?.active.jdId
      && isCanonicalJDId(context.userAssetContext.active.jdId)) {
    try {
      const jd = await services.jdService.getJD(userId, context.userAssetContext.active.jdId);
      if (jd) {
        jdId = jd.id;
        jdTitle = jd.title ?? jd.targetRole;
        if (!jdText) jdText = jd.rawText;
      }
    } catch {
      // ignore
    }
  }

  // ── Resume resolution ──────────────────────────────────────────────
  let resumeId: string | undefined;
  let resumeTitle: string | undefined;
  let resumeText: string | undefined;
  const candidateResumeId = assetScope?.resumeId && isCanonicalResumeId(assetScope.resumeId)
    ? assetScope.resumeId
    : (context.userAssetContext?.active.resumeId
        && isCanonicalResumeId(context.userAssetContext.active.resumeId)
      ? context.userAssetContext.active.resumeId
      : undefined);
  if (candidateResumeId) {
    try {
      const resume = await services.resumeService.getResume(userId, candidateResumeId);
      if (resume) {
        resumeId = resume.id;
        resumeTitle = resume.title;
        resumeText = serializeResumeForGrounding(resume);
      }
    } catch {
      // ignore — resume is optional
    }
  }

  return { experiences, resumeId, resumeTitle, resumeText, jdId, jdText, jdTitle };
}

async function loadExperiencesById(
  context: AgentContext,
  ids: string[],
): Promise<ResolvedExperience[]> {
  const userId = context.userId;
  const services = context.kernel.productServices;
  const expById = new Map<string, ResolvedExperience>();
  for (const id of ids) {
    if (!isCanonicalExperienceId(id)) continue;
    try {
      const exp = await services.experienceService.getExperience(userId, id);
      if (!exp) continue;
      expById.set(id, {
        id: exp.id,
        title: exp.title,
        organization: exp.organization,
        role: exp.role,
        category: exp.category,
        startDate: exp.startDate,
        endDate: exp.endDate,
        tags: exp.tags ?? [],
        content: "",
      });
    } catch {
      // ignore failed lookup
    }
  }
  if (expById.size === 0) return [];
  try {
    const revisions = await services.experienceService.listRevisionsByIds(
      userId,
      Array.from(expById.keys()),
    );
    for (const rev of revisions) {
      const target = expById.get(rev.experienceId);
      if (!target) continue;
      if (!target.content || target.content.length < rev.content.length) {
        target.content = rev.content;
        target.structured = rev.structured as Record<string, unknown> | undefined;
      }
    }
  } catch {
    // ignore — content will simply be empty
  }
  const out: ResolvedExperience[] = [];
  for (const id of ids) {
    const item = expById.get(id);
    if (item) out.push(item);
  }
  return out;
}

function serializeResumeForGrounding(resume: {
  id: string;
  title: string;
  targetRole?: string;
  items: Array<{ title: string; contentSnapshot: string; sectionType?: string }>;
}): string {
  const lines: string[] = [];
  lines.push("Resume: " + resume.title);
  if (resume.targetRole) lines.push("Target role: " + resume.targetRole);
  for (const item of resume.items.slice(0, 30)) {
    lines.push("- [" + (item.sectionType ?? "experience") + "] " + item.title);
    if (item.contentSnapshot) lines.push("  " + item.contentSnapshot.slice(0, 320));
  }
  return lines.join("\n");
}

// Phase 4 — `tryBuildPersonalizationPack` / `tryBuildEvidencePack` were
// extracted into `composeGroundingHelpers.ts` (renamed to
// `buildPersonalizationOutcome` / `buildEvidenceOutcome`). The new helpers
// add bounded timeouts, stable diagnostic tokens, output-type-aware
// preference filtering, an experience-grounded EvidenceRAG fallback path,
// and a separate `buildGuidelineOutcome` that consumes GuidelineRAG style
// rules without ever introducing factual claims.

async function composeWithLLM(input: ComposeContext & { modelClient: ModelClient }): Promise<WritingResult> {
  const { modelClient } = input;
  const prompts = new PromptRegistry();
  const systemPrompt = prompts.get("tools.writing.composeCareerText.system");
  const userPrompt = buildUserPrompt(input);

  const chatRequest: ModelClientChatRequest = {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.4,
    maxTokens: 2048,
    responseFormat: "json",
  };
  const response = await modelClient.chat(chatRequest);
  const parsed = parseLLMJsonObject(response.content);
  if (!parsed) throw new Error("compose_career_text: model returned no parseable JSON object.");
  return normalizeLLMOutput(parsed, input);
}

function buildUserPrompt(input: ComposeContext): string {
  const sections: string[] = [];
  sections.push("# Goal");
  sections.push("outputType: " + input.outputType);
  if (input.goal) sections.push("goal: " + input.goal);
  if (input.constraints.length) sections.push("length: " + input.constraints.length);
  if (input.constraints.language) sections.push("language: " + input.constraints.language);
  if (input.constraints.tone) sections.push("tone: " + input.constraints.tone);
  if (input.constraints.audience) sections.push("audience: " + input.constraints.audience);
  if (input.constraints.format) sections.push("format: " + input.constraints.format);
  sections.push("");
  sections.push("# User instruction");
  sections.push(input.userInstruction.trim() || "(no extra instruction)");
  sections.push("");
  if (input.scope.experiences.length > 0) {
    sections.push("# Experiences (canonical fact source)");
    input.scope.experiences.slice(0, 8).forEach((exp, i) => {
      const headerParts = ["[" + (i + 1) + "] id=" + exp.id + " title=" + exp.title];
      if (exp.organization) headerParts.push("org=" + exp.organization);
      if (exp.role) headerParts.push("role=" + exp.role);
      if (exp.startDate || exp.endDate) headerParts.push("range=" + (exp.startDate ?? "?") + "→" + (exp.endDate ?? "?"));
      if (exp.tags.length > 0) headerParts.push("tags=" + exp.tags.join(","));
      sections.push(headerParts.join(" | "));
      if (exp.content) sections.push(exp.content.slice(0, 800));
      sections.push("");
    });
  } else {
    sections.push("# Experiences");
    sections.push("(none — must say so honestly)");
    sections.push("");
  }
  if (input.scope.resumeText) {
    sections.push("# Active resume snapshot");
    sections.push((input.scope.resumeId ? "id=" + input.scope.resumeId + "\n" : "") + input.scope.resumeText.slice(0, 1500));
    sections.push("");
  }
  if (input.scope.jdText) {
    sections.push("# Target JD");
    sections.push((input.scope.jdId ? "id=" + input.scope.jdId + "\n" : "") + input.scope.jdText.slice(0, 2000));
    sections.push("");
  }
  if (input.evidencePack && input.evidencePack.allowedClaims.length > 0) {
    sections.push("# Pre-vetted evidence claims (use these when possible)");
    input.evidencePack.allowedClaims.slice(0, 12).forEach((claim) => {
      sections.push("- " + (claim.claim ?? "(claim)") + " [experience=" + claim.experienceId + "]");
    });
    sections.push("");
  }
  if (input.personalization) {
    const stable = input.personalization.stablePreferences.map((p) => "- " + p.instruction);
    const contextual = input.personalization.contextualPreferences.map((p) => "- " + p.instruction);
    const negative = input.personalization.negativePreferences.map((p) => "- avoid: " + p.instruction);
    if (stable.length > 0 || contextual.length > 0 || negative.length > 0) {
      sections.push("# Style preferences (tone/voice ONLY — never source of facts)");
      [...stable, ...contextual, ...negative].forEach((line) => sections.push(line));
      sections.push("");
    }
  }
  if (input.styleRules && input.styleRules.length > 0) {
    // Phase 4 — GuidelineRAG style hints. Filtered to remove any rule that
    // smelled like an unverified factual claim (numbers / years / quoted
    // names). These rules influence tone, structure, and industry-specific
    // phrasing only.
    sections.push("# Writing guidelines (style/structure ONLY — never source of facts)");
    input.styleRules.slice(0, 8).forEach((rule) => sections.push("- " + rule));
    sections.push("");
  }
  sections.push("# Reminders");
  sections.push("- Use ONLY facts present above; never invent companies, products, dates, or numbers.");
  sections.push("- Style preferences and writing guidelines influence tone/voice/length only.");
  sections.push("- If you cannot ground the requested output, return status=needs_input with riskNotes.");
  sections.push("- Honor the requested language and length.");
  sections.push("- Return ONLY a single JSON object matching the system contract.");
  return sections.join("\n");
}

function normalizeLLMOutput(raw: Record<string, unknown>, ctx: ComposeContext): WritingResult {
  const validExperienceIds = new Set(ctx.scope.experiences.map((e) => e.id));
  const validResumeIds = new Set(ctx.scope.resumeId ? [ctx.scope.resumeId] : []);
  const validJDIds = new Set(ctx.scope.jdId ? [ctx.scope.jdId] : []);
  const validEvidenceIds = new Set(
    ctx.evidencePack?.allowedClaims.map((c) => c.experienceId).filter(Boolean) ?? [],
  );

  const title = stringField(raw.title) ?? defaultTitle(ctx.outputType);
  const outputType = normalizeOutputType(stringField(raw.outputType)) || ctx.outputType;
  const content = stringField(raw.content) ?? "";
  const alternatives = Array.isArray(raw.alternatives)
    ? raw.alternatives
        .map((alt): { title: string; content: string; scenario?: string } | null => {
          if (typeof alt !== "object" || alt === null) return null;
          const a = alt as Record<string, unknown>;
          const altContent = stringField(a.content);
          if (!altContent) return null;
          return {
            title: stringField(a.title) ?? "",
            content: altContent,
            scenario: stringField(a.scenario),
          };
        })
        .filter((alt): alt is { title: string; content: string; scenario?: string } => alt !== null)
        .slice(0, 4)
    : [];

  const usedExperienceIds = stringArray(raw.usedExperienceIds)
    .filter(isCanonicalExperienceId)
    .filter((id) => validExperienceIds.has(id));
  const usedResumeIds = stringArray(raw.usedResumeIds)
    .filter(isCanonicalResumeId)
    .filter((id) => validResumeIds.has(id));
  const usedJDIds = stringArray(raw.usedJDIds)
    .filter(isCanonicalJDId)
    .filter((id) => validJDIds.has(id));
  const usedEvidenceIds = stringArray(raw.usedEvidenceIds)
    .filter(isCanonicalExperienceId)
    .filter((id) => validEvidenceIds.has(id) || validExperienceIds.has(id));

  const groundingNotes = stringArray(raw.groundingNotes);
  const riskNotes = stringArray(raw.riskNotes);
  const suggestions = stringArray(raw.suggestions);

  return {
    title,
    outputType,
    content,
    alternatives,
    usedExperienceIds,
    usedResumeIds,
    usedJDIds,
    usedEvidenceIds,
    groundingNotes,
    riskNotes,
    suggestions,
  };
}

function defaultTitle(outputType: string): string {
  switch (outputType) {
    case "self_intro": return "自我介绍草稿";
    case "interview_answer": return "面试回答草稿";
    case "cover_letter": return "Cover Letter 草稿";
    case "profile_summary": return "Profile Summary 草稿";
    case "project_intro": return "项目介绍草稿";
    case "application_answer": return "申请表答案草稿";
    case "pitch": return "Elevator Pitch 草稿";
    default: return "求职文本草稿";
  }
}

function normalizeOutputType(value: string | undefined): string {
  if (typeof value !== "string" || !value.trim()) return "custom";
  const trimmed = value.trim();
  return KNOWN_OUTPUT_TYPES.includes(trimmed as typeof KNOWN_OUTPUT_TYPES[number]) ? trimmed : "custom";
}

function composeDeterministic(input: ComposeContext): WritingResult {
  // Test-only deterministic stub. The real product NEVER uses this in
  // dev/prod (gated by isDeterministicFallbackAllowed). Build a compact,
  // clearly-marked draft from the supplied facts so tests can assert on
  // structural fields without depending on a real LLM.
  const exp = input.scope.experiences[0];
  const usedExperienceIds = exp ? [exp.id] : [];
  const usedJDIds = input.scope.jdId ? [input.scope.jdId] : [];
  const usedResumeIds = input.scope.resumeId ? [input.scope.resumeId] : [];
  const language = input.constraints.language ?? "auto";
  const lang = language === "en" ? "en" : "zh";

  const fragments: string[] = [];
  if (exp) {
    if (lang === "en") {
      fragments.push("Drawing on my " + exp.title + (exp.organization ? " at " + exp.organization : "") + ", I focus on practical impact.");
      if (exp.content) fragments.push("Highlights: " + exp.content.slice(0, 200));
    } else {
      fragments.push("基于" + (exp.organization ? exp.organization + "的" : "") + exp.title + "，我专注于真实可验证的产出。");
      if (exp.content) fragments.push("重点经历：" + exp.content.slice(0, 200));
    }
  } else if (input.scope.resumeText) {
    fragments.push(lang === "en"
      ? "Based on the active resume, here is a grounded draft."
      : "基于当前激活的简历，先给出一段保守的草稿。");
  } else if (input.scope.jdText) {
    fragments.push(lang === "en"
      ? "Without saved experiences, here is a JD-anchored draft you can refine."
      : "目前还没有可引用的经历，仅基于 JD 给出可调整的草稿。");
  }
  if (input.scope.jdText) {
    fragments.push(lang === "en"
      ? "Aligning to the target role described in the JD."
      : "结合 JD 中的目标方向进行表达。");
  }

  const content = fragments.join(" ");
  const riskNotes: string[] = [];
  if (!exp) {
    riskNotes.push(lang === "en"
      ? "No saved experiences were available; this draft is intentionally generic."
      : "当前没有可用的经历素材，此草稿故意保持泛化。");
  }
  if (!input.evidencePack) {
    riskNotes.push(lang === "en"
      ? "No Evidence RAG pack was used; metric-level claims should be added by hand."
      : "未启用 Evidence RAG，未引用具体指标，建议人工补充事实细节。");
  }
  if (input.personalization && input.personalization.diagnostics.appliedCount > 0) {
    riskNotes.push(lang === "en"
      ? "PreferenceBank items were used for tone/style only — they did not contribute facts."
      : "PreferenceBank 仅用于风格/口吻，未作为事实来源。");
  }

  return {
    title: defaultTitle(input.outputType),
    outputType: input.outputType,
    content: content || (lang === "en"
      ? "(deterministic stub draft — no model available)"
      : "（测试占位草稿——未连接真实 LLM）"),
    alternatives: [],
    usedExperienceIds,
    usedResumeIds,
    usedJDIds,
    usedEvidenceIds: usedExperienceIds,
    groundingNotes: exp
      ? [(lang === "en" ? "Used experience " : "已引用经历 ") + exp.id + " (" + exp.title + ")."]
      : [],
    riskNotes,
    suggestions: [],
  };
}

function buildSuccessResult(input: {
  writing: WritingResult;
  scope: ResolvedScope;
  evidencePack?: EvidencePack;
  personalization?: PersonalizationPack;
  instructionPack?: InstructionPack;
  composeMethod: "llm" | "deterministic_test_fallback";
  diagnostics?: GroundingDiagnostics;
}): ToolResult {
  const { writing, scope, evidencePack, personalization, instructionPack, composeMethod, diagnostics } = input;

  // Phase 4 — fold grounding diagnostics into riskNotes so they surface
  // uniformly across compose paths. The original riskNotes from the LLM
  // (or deterministic fallback) are preserved verbatim.
  const enrichedRiskNotes = [...writing.riskNotes];
  if (diagnostics) {
    if (diagnostics.evidenceRag.status === "timeout") {
      enrichedRiskNotes.push("Evidence RAG timed out; claims were not retrieved for this draft.");
    } else if (diagnostics.evidenceRag.status === "unavailable") {
      enrichedRiskNotes.push("Evidence RAG was unavailable; claims were not retrieved for this draft.");
    }
    if (diagnostics.guidelineRag.status === "timeout") {
      enrichedRiskNotes.push("Guideline RAG timed out; writing guidelines were not applied.");
    } else if (diagnostics.guidelineRag.status === "unavailable") {
      enrichedRiskNotes.push("Guideline RAG was unavailable; writing guidelines were not applied.");
    } else if (diagnostics.guidelineRag.filteredFactBearingCount > 0) {
      enrichedRiskNotes.push(
        "Guideline RAG returned " + diagnostics.guidelineRag.filteredFactBearingCount
          + " rule(s) mentioning numbers or named entities; those were stripped to avoid unverified facts.",
      );
    }
    if (diagnostics.preferenceBank.appliedCount > 0) {
      enrichedRiskNotes.push("PreferenceBank was used for tone/style only; it never contributed factual claims.");
    }
  }

  const entities: ToolResultEntity[] = [
    {
      type: "writing_result",
      title: writing.title,
      data: {
        outputType: writing.outputType,
        contentPreview: writing.content.slice(0, 240),
        alternativesCount: writing.alternatives.length,
        usedExperienceIds: writing.usedExperienceIds,
        usedResumeIds: writing.usedResumeIds,
        usedJDIds: writing.usedJDIds,
        usedEvidenceIds: writing.usedEvidenceIds,
        composeMethod,
        // Phase 4 — additive observability fields on the existing
        // writing_result entity. No new entity types or top-level
        // ToolResult keys are introduced.
        personalizationApplied: diagnostics?.preferenceBank.appliedCount ?? personalization?.diagnostics.appliedCount ?? 0,
        appliedPreferenceIds: diagnostics?.preferenceBank.appliedPreferenceIds ?? [],
        evidencePackUsed: Boolean(evidencePack),
        evidenceRagTrigger: diagnostics?.evidenceRag.trigger ?? "none",
        evidenceRagStatus: diagnostics?.evidenceRag.status ?? "skipped_no_signal",
        guidelineRagStatus: diagnostics?.guidelineRag.status ?? "skipped_no_service",
        guidelineRagFilteredFactBearingCount: diagnostics?.guidelineRag.filteredFactBearingCount ?? 0,
      },
    },
    ...scope.experiences
      .filter((exp) => writing.usedExperienceIds.includes(exp.id))
      .map<ToolResultEntity>((exp) => ({
        type: "experience",
        id: exp.id,
        title: exp.title,
        data: {
          organization: exp.organization,
          role: exp.role,
          startDate: exp.startDate,
          endDate: exp.endDate,
        },
      })),
    ...(scope.jdId
      ? [{
          type: "jd" as const,
          id: scope.jdId,
          title: scope.jdTitle,
          data: { preview: scope.jdText?.slice(0, 200) },
        }]
      : []),
    ...(scope.resumeId
      ? [{
          type: "resume" as const,
          id: scope.resumeId,
          title: scope.resumeTitle,
        }]
      : []),
  ];

  const evidence: ToolResultEvidence[] = writing.usedExperienceIds.map((id) => {
    const exp = scope.experiences.find((e) => e.id === id);
    return {
      sourceId: id,
      claim: writing.outputType,
      support: exp ? (exp.content.slice(0, 160) || exp.title) : undefined,
    };
  });

  const summaryFacts: string[] = [];
  summaryFacts.push("Drafted a " + writing.outputType + " grounded on " + writing.usedExperienceIds.length + " experience(s).");
  if (writing.usedJDIds.length > 0) summaryFacts.push("Anchored to JD " + writing.usedJDIds.join(", ") + ".");
  if (writing.usedResumeIds.length > 0) summaryFacts.push("Referenced resume " + writing.usedResumeIds.join(", ") + ".");
  if (writing.usedEvidenceIds.length > 0) summaryFacts.push("Cited " + writing.usedEvidenceIds.length + " evidence claim(s).");
  if (diagnostics && (diagnostics.evidenceRag.status === "ok" || diagnostics.evidenceRag.status === "ok_empty")) {
    summaryFacts.push("Evidence RAG trigger: " + diagnostics.evidenceRag.trigger + ".");
  }
  if (diagnostics?.guidelineRag.status === "ok") {
    summaryFacts.push("Guideline RAG: applied (style only).");
  }
  if (diagnostics && diagnostics.preferenceBank.appliedCount > 0) {
    summaryFacts.push("PreferenceBank: applied " + diagnostics.preferenceBank.appliedCount + " style preference(s).");
  }
  summaryFacts.push("Compose method: " + composeMethod + ".");

  const warnings: string[] = [];
  if (writing.usedExperienceIds.length === 0) {
    warnings.push("No experience ids were cited — caller may want to follow up with experience details.");
  }
  if (composeMethod === "deterministic_test_fallback") {
    warnings.push("Deterministic test fallback was used; do not surface this output in production traffic.");
  }
  // Phase 4 — emit stable, parseable warning tokens whenever a RAG service
  // failed or was skipped while we DID have a JD/experience signal to feed it.
  if (diagnostics) {
    if (diagnostics.evidenceRag.status === "unavailable") {
      warnings.push("evidence_rag_unavailable" + (diagnostics.evidenceRag.detail ? ": " + diagnostics.evidenceRag.detail : ""));
    } else if (diagnostics.evidenceRag.status === "timeout") {
      warnings.push("evidence_rag_timeout");
    } else if (diagnostics.evidenceRag.status === "skipped_no_signal" && (scope.jdText || scope.experiences.length > 0)) {
      warnings.push("evidence_rag_skipped_no_signal");
    }
    if (diagnostics.guidelineRag.status === "unavailable") {
      warnings.push("guideline_rag_unavailable");
    } else if (diagnostics.guidelineRag.status === "timeout") {
      warnings.push("guideline_rag_timeout");
    }
  } else if (!evidencePack && scope.jdText) {
    // Backwards-compatible fallback for callers that did not pass diagnostics.
    warnings.push("Evidence RAG was not consulted; metric-level claims should be hand-verified.");
  }

  const nextActionHints: ToolResultNextActionHint[] = [];
  nextActionHints.push({
    type: "compose_career_text_variant",
    label: "Generate a shorter / longer / English version of this draft",
    payload: { outputType: writing.outputType },
  });
  if (writing.usedExperienceIds.length > 0) {
    nextActionHints.push({
      type: "open_experience",
      label: "Open the cited experiences",
      payload: { experienceIds: writing.usedExperienceIds },
    });
  }

  return {
    status: "success",
    message: writing.content
      ? writing.content.length <= 140
        ? writing.content
        : writing.content.slice(0, 140) + "…"
      : writing.title,
    visibility: "user_summary",
    actionResult: {
      status: "success",
      actionType: "compose_career_text",
      metadata: {
        outputType: writing.outputType,
        composeMethod,
        usedExperienceCount: writing.usedExperienceIds.length,
      },
    },
    data: {
      title: writing.title,
      outputType: writing.outputType,
      content: writing.content,
      alternatives: writing.alternatives,
      usedExperienceIds: writing.usedExperienceIds,
      usedResumeIds: writing.usedResumeIds,
      usedJDIds: writing.usedJDIds,
      usedEvidenceIds: writing.usedEvidenceIds,
      groundingNotes: writing.groundingNotes,
      riskNotes: enrichedRiskNotes,
      suggestions: writing.suggestions,
      composeMethod,
      personalizationApplied: diagnostics?.preferenceBank.appliedCount ?? personalization?.diagnostics.appliedCount ?? 0,
      appliedPreferenceIds: diagnostics?.preferenceBank.appliedPreferenceIds ?? [],
      evidencePackUsed: Boolean(evidencePack),
      // Phase 4 — additive grounding diagnostics. Front-end may inspect
      // these for richer attribution; existing front-ends ignore them.
      groundingDiagnostics: diagnostics
        ? {
            evidenceRag: diagnostics.evidenceRag,
            guidelineRag: diagnostics.guidelineRag,
            preferenceBank: {
              status: diagnostics.preferenceBank.status,
              appliedCount: diagnostics.preferenceBank.appliedCount,
              filteredByOutputType: diagnostics.preferenceBank.filteredByOutputType,
            },
          }
        : undefined,
      guidelineRagApplied: diagnostics?.guidelineRag.status === "ok",
      instructionPackVersion: instructionPack?.version,
    },
    resultKind: "asset_grounded_text_completed",
    summaryFacts,
    entities,
    evidence,
    ...(warnings.length > 0 ? { warnings } : {}),
    nextActionHints,
  };
}

function needsInputResult(input: {
  reason: string;
  message: string;
  missingInputs: string[];
  outputType: string;
  requestedExperienceQuery?: string;
}): ToolResult {
  return {
    status: "needs_input",
    message: input.message,
    visibility: "error_user_visible",
    actionResult: {
      status: "needs_input",
      actionType: "compose_career_text",
      reason: input.reason,
      missingInputs: input.missingInputs,
      message: input.message,
    },
    data: {
      title: defaultTitle(input.outputType),
      outputType: input.outputType,
      content: "",
      alternatives: [],
      usedExperienceIds: [],
      usedResumeIds: [],
      usedJDIds: [],
      usedEvidenceIds: [],
      groundingNotes: [],
      riskNotes: [input.message],
      suggestions: input.requestedExperienceQuery
        ? ["先在经历库中保存 \"" + input.requestedExperienceQuery + "\" 相关的经历，再回来让我写。"]
        : ["先保存几条真实经历，或粘贴一份 JD，我就能基于真实素材生成内容。"],
      composeMethod: "needs_input",
      personalizationApplied: 0,
      evidencePackUsed: false,
    },
    resultKind: "asset_grounded_text_needs_input",
    summaryFacts: ["compose_career_text returned needs_input: " + input.reason + "."],
    entities: [],
    evidence: [],
    warnings: [input.message],
    nextActionHints: input.missingInputs.includes("experienceText")
      ? [{ type: "import_resume_file", label: "Import a resume to seed the experience library", payload: {} }]
      : [],
  };
}

function llmFailedResult(error: unknown, outputType: string, _scope: ResolvedScope): ToolResult {
  const detail = error instanceof Error ? error.message : "Unknown LLM error";
  return {
    status: "failed",
    message: "写作模型暂时不可用，请稍后重试。(" + detail + ")",
    visibility: "error_user_visible",
    actionResult: {
      status: "failed",
      actionType: "compose_career_text",
      reason: "llm_failed",
      message: detail,
    },
    data: {
      title: defaultTitle(outputType),
      outputType,
      content: "",
      alternatives: [],
      usedExperienceIds: [],
      usedResumeIds: [],
      usedJDIds: [],
      usedEvidenceIds: [],
      groundingNotes: [],
      riskNotes: ["LLM call failed: " + detail],
      suggestions: [],
      composeMethod: "llm_failed",
      personalizationApplied: 0,
      evidencePackUsed: false,
    },
    resultKind: "asset_grounded_text_needs_input",
    summaryFacts: ["compose_career_text failed: LLM error."],
    warnings: ["LLM call failed: " + detail],
    nextActionHints: [],
  };
}

function llmNotConfiguredResult(outputType: string): ToolResult {
  return {
    status: "needs_input",
    message: "当前 AI 模型服务未配置，无法生成写作草稿。请先配置 API Key 或在测试环境运行。",
    visibility: "error_user_visible",
    actionResult: {
      status: "needs_input",
      actionType: "compose_career_text",
      reason: "model_not_available",
      message: "model_not_available",
    },
    data: {
      title: defaultTitle(outputType),
      outputType,
      content: "",
      alternatives: [],
      usedExperienceIds: [],
      usedResumeIds: [],
      usedJDIds: [],
      usedEvidenceIds: [],
      groundingNotes: [],
      riskNotes: ["LLM provider not configured."],
      suggestions: [],
      composeMethod: "llm_not_configured",
      personalizationApplied: 0,
      evidencePackUsed: false,
    },
    resultKind: "asset_grounded_text_needs_input",
    summaryFacts: ["compose_career_text could not run: LLM provider missing."],
    warnings: ["LLM provider not configured."],
    nextActionHints: [],
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function parseLLMJsonObject(content: string): Record<string, unknown> | undefined {
  const trimmed = content.trim();
  if (!trimmed) return undefined;
  // Strip optional markdown code-fence.
  const fenced = trimmed.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/);
  const candidate = fenced?.[1] ?? trimmed;
  try {
    const parsed = JSON.parse(candidate);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to brace-extraction
  }
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}
