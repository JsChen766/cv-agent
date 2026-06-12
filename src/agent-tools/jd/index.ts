import type { ToolDefinition } from "../../agent-core/tools/Tool.js";
import { IdInputSchema, JDInputSchema, ListInputSchema, TextInputSchema, ToolResultSchema } from "../../agent-core/validation/ToolInputSchemas.js";
import { computeJDHash } from "../../product/jdHash.js";
import { normalizeDraftContext } from "../../copilot/context/DraftContext.js";
import { isDefaultTitle } from "../../copilot/SessionDisplayProjector.js";

export function createJDAgentTools(): ToolDefinition[] {
  return [
    {
      name: "analyze_jd",
      description: "Analyze a job description, match it against the user's experience library, and recommend next actions.",
      ownerAgent: "strategist",
      inputSchema: TextInputSchema,
      outputSchema: ToolResultSchema,
      mutability: "read",
      requiresConfirmation: false,
      riskLevel: "low",
      execute: async (input, context) => {
        const rawText = String(input.text || "").trim();
        if (!rawText) {
          return {
            status: "needs_input",
            message: "Please provide JD text to analyze.",
            visibility: "error_user_visible",
            actionResult: { actionType: "analyze_jd", status: "needs_input", missingInputs: ["text"] },
          };
        }

        const jd = parseJD(rawText);
        const experiences = await context.kernel.productServices.experienceService.listExperiences(context.userId, { limit: 50, status: "active" });
        const matchedExperiences = matchExperiencesForJD(jd, experiences);
        const resumeGaps = buildResumeGaps(jd, matchedExperiences);
        const summary = summarizeAnalysis(jd, matchedExperiences, resumeGaps);
        const result = {
          jdAnalysisResult: true,
          jdTitle: jd.jdTitle,
          company: jd.company,
          roleType: jd.roleType,
          location: jd.location,
          requirements: jd.requirements,
          responsibilities: jd.responsibilities,
          resumeGaps,
          matchedExperiences,
          nextActions: buildNextActions(rawText, jd),
          summary,
          rawText,
        };

        return {
          status: "success",
          message: "JD analysis completed.",
          data: result,
          visibility: "user_summary",
          workspacePatch: { activePanel: "jd_matching" },
          actionResult: {
            actionType: "analyze_jd",
            status: "success",
            message: "JD analysis completed.",
            metadata: {
              jdTitle: jd.jdTitle,
              company: jd.company,
              matchCount: matchedExperiences.length,
              gapCount: resumeGaps.length,
            },
          },
        };
      },
    },
    {
      name: "list_jds",
      description: "List saved JD records.",
      ownerAgent: "strategist",
      inputSchema: ListInputSchema,
      outputSchema: ToolResultSchema,
      mutability: "read",
      requiresConfirmation: false,
      riskLevel: "low",
      execute: async (input, context) => {
        const items = await context.kernel.productServices.jdService.listJDs(context.userId, typeof input.limit === "number" ? input.limit : 50);
        return { status: "success", message: `Found ${items.length} JD(s).`, data: { count: items.length, items }, workspacePatch: { activePanel: "jd_library", jds: items }, visibility: "internal" };
      },
    },
    {
      name: "get_jd",
      description: "Get a saved JD record.",
      ownerAgent: "strategist",
      inputSchema: IdInputSchema,
      outputSchema: ToolResultSchema,
      mutability: "read",
      requiresConfirmation: false,
      riskLevel: "low",
      execute: async (input, context) => {
        const jd = await context.kernel.productServices.jdService.getJD(context.userId, String(input.id));
        return jd
          ? { status: "success", message: `Loaded JD "${jd.title}".`, data: { jd }, workspacePatch: { activePanel: "jd_library", jdId: jd.id, active: { jdId: jd.id } }, visibility: "internal" }
          : { status: "failed", message: "JD not found.", data: { id: input.id }, visibility: "error_user_visible" };
      },
    },
    {
      name: "prepare_save_jd_from_text",
      description: "Preview saving JD text.",
      ownerAgent: "strategist",
      inputSchema: TextInputSchema,
      outputSchema: ToolResultSchema,
      mutability: "read",
      requiresConfirmation: false,
      riskLevel: "low",
      execute: async (input) => ({ status: "success", message: "Prepared JD save for confirmation.", data: { preview: { rawText: input.text } }, visibility: "internal" }),
    },
    {
      name: "save_jd_from_text",
      description: "Save a JD record.",
      ownerAgent: "strategist",
      inputSchema: JDInputSchema,
      outputSchema: ToolResultSchema,
      mutability: "write",
      requiresConfirmation: true,
      riskLevel: "medium",
      execute: async (input, context) => {
        const rawText = String(input.text);
        const jdHash = computeJDHash(rawText);
        const now = new Date().toISOString();
        const normalizedDrafts = normalizeDraftContext(context.workspace?.drafts);
        const jdDraftsAfterSave = markSavedJDDrafts(normalizedDrafts.jdDrafts, jdHash, now);
        const existing = await context.kernel.productServices.jdService.listJDs(context.userId, 1000);
        const duplicate = existing.find((item) => computeJDHash(item.rawText) === jdHash);
        if (duplicate) {
          return {
            status: "success",
            message: "这份 JD 已在库中，已为你打开该 JD。",
            data: { jd: duplicate, jdId: duplicate.id, jdHash },
            workspacePatch: {
              activePanel: "jd_library",
              jdId: duplicate.id,
              active: { jdId: duplicate.id, jdDraftId: undefined },
              drafts: { ...normalizedDrafts, jdDrafts: jdDraftsAfterSave },
            },
            visibility: "user_summary",
            actionResult: {
              actionType: "save_jd_from_text",
              status: "success",
              metadata: {
                jdId: duplicate.id,
                duplicate: true,
                jdHash,
              },
            },
          };
        }
        const jd = await context.kernel.productServices.jdService.saveJD(context.userId, {
          rawText,
          title: typeof input.title === "string" ? input.title : undefined,
          company: typeof input.company === "string" ? input.company : undefined,
          targetRole: typeof input.targetRole === "string" ? input.targetRole : undefined,
        });
        // Back-write the resolved targetRole onto the session so the
        // sidebar projector can derive a real display title instead of
        // leaving it on the literal "New Copilot chat" the orchestrator
        // assigned at session creation. Existing user-renamed titles are
        // never overwritten — `isDefaultTitle` only matches the
        // well-known placeholders.
        await maybeBackwriteSessionTitle(context, { targetRole: jd.targetRole ?? jd.title });
        return {
          status: "success",
          message: `Saved JD "${jd.title}".`,
          data: { jd, jdId: jd.id, jdHash },
          workspacePatch: {
            activePanel: "jd_library",
            jdId: jd.id,
            active: { jdId: jd.id, jdDraftId: undefined },
            drafts: { ...normalizedDrafts, jdDrafts: jdDraftsAfterSave },
          },
          visibility: "user_summary",
          actionResult: {
            actionType: "save_jd_from_text",
            status: "success",
            metadata: {
              jdId: jd.id,
              duplicate: false,
              jdHash,
            },
          },
        };
      },
    },
  ];
}

async function maybeBackwriteSessionTitle(
  context: { userId: string; sessionId: string; kernel: { copilotServices: { sessionService: { getSession: (u: string, s: string) => Promise<{ title?: string | null; targetRole?: string | null } | null>; updateSession: (u: string, s: string, p: Record<string, unknown>) => Promise<unknown> } } } },
  patch: { targetRole?: string | null },
): Promise<void> {
  if (!context.sessionId) return;
  const targetRole = (patch.targetRole ?? "").trim();
  if (!targetRole) return;
  try {
    const session = await context.kernel.copilotServices.sessionService.getSession(context.userId, context.sessionId);
    if (!session) return;
    const sessionTitle = (session.title ?? "").trim();
    const update: Record<string, unknown> = {};
    // Only rewrite targetRole when missing — never clobber a user-renamed
    // session role from a different JD save.
    if (!session.targetRole) update.targetRole = targetRole;
    if (isDefaultTitle(sessionTitle)) update.title = null;
    if (Object.keys(update).length === 0) return;
    await context.kernel.copilotServices.sessionService.updateSession(context.userId, context.sessionId, update);
  } catch {
    // Title back-write is a UX nicety; never fail the saveJD flow on it.
  }
}

type JDRequirement = {
  type: "skill" | "education" | "experience" | "tool" | "personality" | "other";
  text: string;
  importance: "must_have" | "nice_to_have" | "unknown";
};

type ParsedJD = {
  jdTitle: string;
  company: string | null;
  roleType: "internship" | "full_time" | "part_time" | "unknown";
  location: string | null;
  requirements: JDRequirement[];
  responsibilities: string[];
  keywords: string[];
};

function parseJD(rawText: string): ParsedJD {
  const lines = rawText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const jdTitle = inferTitle(lines, rawText);
  const company = inferField(rawText, ["company", "employer", "organization"]);
  const location = inferField(rawText, ["location", "city"]);
  const roleType = /intern|internship|实习/i.test(rawText)
    ? "internship"
    : /part[- ]time|兼职/i.test(rawText)
      ? "part_time"
      : /full[- ]time|全职/i.test(rawText)
        ? "full_time"
        : "unknown";
  const bullets = lines
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter((line) => line.length > 6);
  const requirements = bullets
    .filter((line) => /require|qualification|must|skill|experience|degree|bachelor|master|熟悉|经验|要求|能力/i.test(line))
    .slice(0, 12)
    .map((line) => ({
      type: requirementType(line),
      text: line,
      importance: requirementImportance(line),
    }));
  const responsibilities = bullets
    .filter((line) => /responsib|develop|build|lead|own|design|work with|负责|开发|设计|协作/i.test(line))
    .slice(0, 10);
  const keywords = extractKeywords(rawText);
  return {
    jdTitle,
    company,
    roleType,
    location,
    requirements: requirements.length ? requirements : keywords.slice(0, 8).map((keyword) => ({ type: "skill", text: keyword, importance: "unknown" as const })),
    responsibilities,
    keywords,
  };
}

function matchExperiencesForJD(
  jd: ParsedJD,
  experiences: Array<{ id: string; title: string; organization?: string; role?: string; content?: string; structured?: Record<string, unknown>; tags?: string[] }>,
) {
  const jdTerms = new Set(jd.keywords.map((item) => item.toLowerCase()));
  return experiences
    .map((experience) => {
      const text = [
        experience.title,
        experience.organization,
        experience.role,
        experience.content,
        ...(experience.tags || []),
        ...Object.values(experience.structured || {}).flatMap((value) => Array.isArray(value) ? value : [value]),
      ].filter(Boolean).join(" ").toLowerCase();
      const matched = [...jdTerms].filter((term) => text.includes(term));
      const score = jdTerms.size ? Number((matched.length / Math.max(1, jdTerms.size)).toFixed(2)) : null;
      return {
        experienceId: experience.id || null,
        title: experience.title || "Untitled experience",
        reason: matched.length ? `Matches: ${matched.slice(0, 6).join(", ")}` : "No strong keyword overlap found.",
        score,
      };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 6);
}

function buildResumeGaps(jd: ParsedJD, matches: Array<{ score: number | null }>) {
  const bestScore = Math.max(0, ...matches.map((item) => item.score ?? 0));
  const gaps = jd.requirements
    .filter((requirement) => requirement.importance === "must_have")
    .slice(0, bestScore >= 0.5 ? 4 : 7)
    .map((requirement) => ({
      gap: requirement.text,
      severity: bestScore >= 0.55 ? "low" as const : bestScore >= 0.25 ? "medium" as const : "high" as const,
      suggestion: `Add stronger evidence for: ${requirement.text.slice(0, 90)}`,
    }));
  if (!gaps.length && bestScore < 0.25) {
    gaps.push({
      gap: "No clearly matching experience found in the current library.",
      severity: "high" as const,
      suggestion: "Import or write one relevant experience before generating the resume.",
    });
  }
  return gaps;
}

function buildNextActions(rawText: string, jd: ParsedJD) {
  return [
    {
      id: "generate_resume",
      label: "Generate resume from this JD",
      actionType: "generate_resume" as const,
      payload: { jdText: rawText, targetRole: jd.jdTitle },
    },
    {
      id: "optimize_resume",
      label: "Optimize resume first",
      actionType: "optimize_resume" as const,
      payload: { jdText: rawText, targetRole: jd.jdTitle },
    },
    {
      id: "save_jd",
      label: "Save JD",
      actionType: "save_jd" as const,
      payload: { text: rawText, title: jd.jdTitle, company: jd.company ?? undefined, targetRole: jd.jdTitle },
    },
  ];
}

function summarizeAnalysis(jd: ParsedJD, matches: Array<{ score: number | null }>, gaps: Array<{ severity: string }>): string {
  const bestScore = Math.max(0, ...matches.map((item) => item.score ?? 0));
  const level = bestScore >= 0.55 ? "good" : bestScore >= 0.25 ? "partial" : "weak";
  const highGaps = gaps.filter((gap) => gap.severity === "high").length;
  return `This JD looks like a ${jd.roleType.replace("_", " ")} role. Current experience match is ${level}; ${highGaps} high-severity gap(s) need attention.`;
}

function inferTitle(lines: string[], rawText: string): string {
  const labeled = inferField(rawText, ["title", "role", "position", "job title"]);
  if (labeled) return labeled;
  const first = lines.find((line) => line.length <= 100 && !/^(about|responsibilities|requirements)[:：]?$/i.test(line));
  return first || "Untitled role";
}

function inferField(text: string, labels: string[]): string | null {
  for (const label of labels) {
    const match = text.match(new RegExp(`${label}\\s*[:：-]\\s*([^\\n]+)`, "i"));
    if (match?.[1]) return match[1].trim().slice(0, 120);
  }
  return null;
}

function requirementType(line: string): JDRequirement["type"] {
  if (/degree|bachelor|master|phd|education|学历|本科|硕士/i.test(line)) return "education";
  if (/year|experience|background|经验/i.test(line)) return "experience";
  if (/python|java|sql|react|vue|typescript|excel|figma|aws|tool/i.test(line)) return "tool";
  if (/communicat|ownership|collaborat|personality|沟通|协作/i.test(line)) return "personality";
  if (/skill|能力|熟悉/i.test(line)) return "skill";
  return "other";
}

function requirementImportance(line: string): JDRequirement["importance"] {
  if (/preferred|nice|plus|加分|优先/i.test(line)) return "nice_to_have";
  if (/must|required|要求|至少/i.test(line)) return "must_have";
  return "unknown";
}

function extractKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  const known = ["python", "java", "javascript", "typescript", "react", "vue", "node", "sql", "excel", "data", "analytics", "machine learning", "ai", "llm", "frontend", "backend", "product", "design", "figma", "aws", "docker", "kubernetes"];
  const found = known.filter((keyword) => lower.includes(keyword));
  const words = lower.match(/[a-z][a-z+#.-]{2,}/g) || [];
  return [...new Set([...found, ...words.filter((word) => word.length > 4).slice(0, 20)])].slice(0, 24);
}

function markSavedJDDrafts(
  drafts: Array<{ rawText: string; status: string; updatedAt: string; lastReferencedAt: string }>,
  jdHash: string,
  now: string,
) {
  let matched = false;
  return drafts.map((draft) => {
    if (computeJDHash(draft.rawText || "") !== jdHash) return draft;
    matched = true;
    return {
      ...draft,
      status: "saved",
      updatedAt: now,
      lastReferencedAt: now,
    };
  }).filter((draft) => matched ? draft.status !== "saved" : true);
}
